import { LocalDispatcher } from './local.js';

/**
 * Dispatcher that enqueues tasks to Redis instead of running them directly.
 *
 * On the API server side, spawn() pushes the task to Redis and returns
 * a ProcessHandle that subscribes to Redis pub/sub for logs and status.
 *
 * Actual execution happens in a separate worker pod (src/worker.js)
 * that pulls from the same Redis queue and runs the Claude process locally.
 */
export class RedisDispatcher {
  /**
   * @param {import('../queue/redis.js').RedisQueue} queue - Shared Redis queue instance
   */
  constructor(queue) {
    this.queue = queue;
  }

  /**
   * Enqueue a task and return a handle that streams results from Redis.
   *
   * This does NOT run the process — it pushes it to Redis for a worker pod
   * to pick up. The returned ProcessHandle wires up pub/sub so the caller
   * (server.js) sees the same onData/onExit interface as local execution.
   *
   * @param {string} command
   * @param {string[]} args
   * @param {import('./index.js').SpawnOptions} options
   * @returns {import('./index.js').ProcessHandle}
   */
  spawn(command, args, options) {
    const taskId = options.taskId;
    if (!taskId) throw new Error('RedisDispatcher requires options.taskId');

    let dataCallback = null;
    let exitCallback = null;

    // Subscribe to log and status channels for this task
    const unsubLogs = this.queue.subscribeLogs(taskId, (data) => {
      dataCallback?.(data);
    });

    const unsubStatus = this.queue.subscribeStatus(taskId, (status) => {
      if (status.event === 'exit') {
        unsubLogs();
        unsubStatus();
        exitCallback?.({ exitCode: status.exitCode ?? 1 });
      }
    });

    // Enqueue the work item
    this.queue.enqueue(taskId, {
      command,
      args: JSON.stringify(args),
      cwd: options.cwd || '/tmp/work',
      env: JSON.stringify(options.env || {}),
      cols: String(options.cols || 200),
      rows: String(options.rows || 50),
      phase: options.phase || 'unknown',
      prompt: options.prompt || '',
    }).catch((err) => {
      console.error(`[redis-dispatch] Failed to enqueue task ${taskId}:`, err.message);
      exitCallback?.({ exitCode: 1 });
    });

    return {
      pid: `redis:${taskId}`,
      onData: (cb) => { dataCallback = cb; },
      onExit: (cb) => { exitCallback = cb; },
      kill: () => {
        // Publish a kill signal; the worker checks for it
        this.queue.publishStatus(taskId, { event: 'kill' }).catch(() => {});
        unsubLogs();
        unsubStatus();
      },
    };
  }
}

/**
 * Worker-side executor that pulls tasks from Redis and runs them locally.
 *
 * This runs in worker pods. It blocks on BRPOP waiting for tasks,
 * spawns them with LocalDispatcher, and streams results back via Redis.
 */
export class RedisWorkerExecutor {
  /**
   * @param {import('../queue/redis.js').RedisQueue} queue
   */
  constructor(queue) {
    this.queue = queue;
    this.localDispatcher = new LocalDispatcher();
    this.running = false;
    this.currentProc = null;
  }

  /**
   * Start the worker loop. Blocks and processes tasks until stop() is called.
   */
  async start() {
    this.running = true;
    console.log('[worker] Waiting for tasks...');

    while (this.running) {
      let task;
      try {
        task = await this.queue.dequeue(10);
      } catch (err) {
        console.error('[worker] Dequeue error:', err.message);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      if (!task) continue; // timeout, loop again

      console.log(`[worker] Picked up task ${task.id} (phase: ${task.phase})`);

      try {
        await this.executeTask(task);
      } catch (err) {
        console.error(`[worker] Task ${task.id} failed:`, err.message);
        await this.queue.updateTask(task.id, {
          status: 'failed',
          error: err.message,
          errorType: 'exit_code',
          finished: new Date().toISOString(),
        });
        await this.queue.publishStatus(task.id, {
          event: 'exit',
          exitCode: 1,
          error: err.message,
        });
      }
    }
  }

  /**
   * Execute a single task pulled from the queue.
   */
  async executeTask(task) {
    const args = JSON.parse(task.args || '[]');
    const env = JSON.parse(task.env || '{}');

    await this.queue.updateTask(task.id, { status: 'running' });

    return new Promise((resolve, reject) => {
      let killed = false;

      // Listen for kill signals
      const unsubKill = this.queue.subscribeStatus(task.id, (status) => {
        if (status.event === 'kill') {
          killed = true;
          this.currentProc?.kill();
          unsubKill();
        }
      });

      const proc = this.localDispatcher.spawn(task.command, args, {
        cwd: task.cwd,
        env,
        cols: parseInt(task.cols) || 200,
        rows: parseInt(task.rows) || 50,
      });

      this.currentProc = proc;

      proc.onData((data) => {
        // Stream logs back via Redis pub/sub + persist
        this.queue.publishLog(task.id, data).catch(() => {});
        this.queue.appendLog(task.id, data).catch(() => {});
      });

      proc.onExit(async ({ exitCode }) => {
        this.currentProc = null;
        unsubKill();

        const status = exitCode === 0 ? 'completed' : 'failed';
        const update = {
          status,
          finished: new Date().toISOString(),
        };
        if (exitCode !== 0) {
          update.errorType = killed ? 'killed' : 'exit_code';
        }

        await this.queue.updateTask(task.id, update);
        await this.queue.publishStatus(task.id, {
          event: 'exit',
          exitCode,
        });

        console.log(`[worker] Task ${task.id} ${status} (exit: ${exitCode})`);

        exitCode === 0 ? resolve() : reject(new Error(`Process exited with code ${exitCode}`));
      });
    });
  }

  /**
   * Stop the worker loop gracefully.
   */
  stop() {
    this.running = false;
    this.currentProc?.kill();
  }
}
