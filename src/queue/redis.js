import Redis from 'ioredis';

/**
 * Redis-backed task queue and state store for inter-pod communication.
 *
 * Architecture:
 * - Tasks are queued via a Redis list (LPUSH/BRPOP for FIFO)
 * - Task state is stored in Redis hashes (task:{id})
 * - Log streaming uses Redis pub/sub (logs:{id})
 * - Status updates use Redis pub/sub (status:{id})
 *
 * This replaces the in-memory Map and K8s API polling with a shared
 * data store that any pod can read/write without K8s API access.
 */

const TASK_QUEUE_KEY = 'claude:tasks:pending';
const TASK_PREFIX = 'claude:task:';
const LOG_CHANNEL_PREFIX = 'claude:logs:';
const STATUS_CHANNEL_PREFIX = 'claude:status:';
const TASK_TTL = 7 * 24 * 60 * 60; // 7 days

export class RedisQueue {
  /**
   * @param {string} redisUrl - Redis connection URL (e.g. redis://host:6379)
   */
  constructor(redisUrl) {
    this.redisUrl = redisUrl;

    // Main client for commands
    this.redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 500, 5000),
    });

    // Separate client for blocking operations (BRPOP)
    this.blockingRedis = new Redis(redisUrl, {
      maxRetriesPerRequest: null, // BRPOP blocks indefinitely
      retryStrategy: (times) => Math.min(times * 500, 5000),
    });

    // Separate client for pub/sub subscriptions
    this.subRedis = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 500, 5000),
    });

    // Separate client for publishing (can't publish on a sub client)
    this.pubRedis = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 500, 5000),
    });

    this.redis.on('error', (err) => console.error('[redis] Connection error:', err.message));
    this.blockingRedis.on('error', (err) => console.error('[redis:blocking] Connection error:', err.message));
    this.subRedis.on('error', (err) => console.error('[redis:sub] Connection error:', err.message));
    this.pubRedis.on('error', (err) => console.error('[redis:pub] Connection error:', err.message));
  }

  // ========== Task State ==========

  /**
   * Save task metadata to Redis hash.
   */
  async setTask(id, data) {
    const key = TASK_PREFIX + id;
    const flat = {};
    for (const [k, v] of Object.entries(data)) {
      flat[k] = v === null || v === undefined ? '' : String(v);
    }
    await this.redis.hset(key, flat);
    await this.redis.expire(key, TASK_TTL);
  }

  /**
   * Get task metadata from Redis hash.
   * Returns null if task doesn't exist.
   */
  async getTask(id) {
    const key = TASK_PREFIX + id;
    const data = await this.redis.hgetall(key);
    if (!data || Object.keys(data).length === 0) return null;
    // Convert empty strings back to null for known nullable fields
    for (const field of ['pr_url', 'errorType', 'error', 'finished']) {
      if (data[field] === '') data[field] = null;
    }
    return data;
  }

  /**
   * Update specific fields on a task.
   */
  async updateTask(id, fields) {
    const key = TASK_PREFIX + id;
    const flat = {};
    for (const [k, v] of Object.entries(fields)) {
      flat[k] = v === null || v === undefined ? '' : String(v);
    }
    await this.redis.hset(key, flat);
  }

  /**
   * List all tasks (scans for task keys).
   */
  async listTasks() {
    const keys = [];
    let cursor = '0';
    do {
      const [nextCursor, batch] = await this.redis.scan(cursor, 'MATCH', TASK_PREFIX + '*', 'COUNT', 100);
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== '0');

    const tasks = [];
    for (const key of keys) {
      const id = key.slice(TASK_PREFIX.length);
      const data = await this.getTask(id);
      if (data) tasks.push({ id, ...data });
    }

    tasks.sort((a, b) => new Date(b.started) - new Date(a.started));
    return tasks;
  }

  // ========== Task Queue ==========

  /**
   * Enqueue a task for worker pickup.
   * Pushes the task ID to the pending queue.
   */
  async enqueue(id, taskData) {
    // Store task state first
    await this.setTask(id, {
      ...taskData,
      status: 'queued',
      started: new Date().toISOString(),
    });
    // Push to queue
    await this.redis.lpush(TASK_QUEUE_KEY, id);
  }

  /**
   * Dequeue the next task (blocks until one is available).
   * Returns { id, ...taskData } or null on timeout.
   *
   * @param {number} timeoutSeconds - How long to block waiting
   */
  async dequeue(timeoutSeconds = 30) {
    const result = await this.blockingRedis.brpop(TASK_QUEUE_KEY, timeoutSeconds);
    if (!result) return null;

    const [, id] = result;
    const task = await this.getTask(id);
    if (!task) return null;

    return { id, ...task };
  }

  // ========== Log Streaming ==========

  /**
   * Publish a log chunk for a task.
   * Workers call this to stream output back to the API server.
   */
  async publishLog(taskId, data) {
    await this.pubRedis.publish(LOG_CHANNEL_PREFIX + taskId, data);
  }

  /**
   * Append to the persisted log buffer for a task.
   * Allows late-joining clients to catch up.
   */
  async appendLog(taskId, data) {
    const key = `claude:logbuf:${taskId}`;
    await this.redis.append(key, data);
    await this.redis.expire(key, TASK_TTL);
  }

  /**
   * Get the full persisted log buffer for a task.
   */
  async getLogBuffer(taskId) {
    return await this.redis.get(`claude:logbuf:${taskId}`) || '';
  }

  /**
   * Subscribe to log output for a task.
   * Returns an unsubscribe function.
   *
   * @param {string} taskId
   * @param {function(string): void} callback
   */
  subscribeLogs(taskId, callback) {
    const channel = LOG_CHANNEL_PREFIX + taskId;
    this.subRedis.subscribe(channel);

    const handler = (ch, message) => {
      if (ch === channel) callback(message);
    };
    this.subRedis.on('message', handler);

    return () => {
      this.subRedis.unsubscribe(channel);
      this.subRedis.removeListener('message', handler);
    };
  }

  // ========== Status Updates ==========

  /**
   * Publish a status change for a task.
   */
  async publishStatus(taskId, status) {
    await this.pubRedis.publish(
      STATUS_CHANNEL_PREFIX + taskId,
      JSON.stringify(status)
    );
  }

  /**
   * Subscribe to status updates for a task.
   * Returns an unsubscribe function.
   */
  subscribeStatus(taskId, callback) {
    const channel = STATUS_CHANNEL_PREFIX + taskId;
    this.subRedis.subscribe(channel);

    const handler = (ch, message) => {
      if (ch === channel) {
        try { callback(JSON.parse(message)); }
        catch { callback(message); }
      }
    };
    this.subRedis.on('message', handler);

    return () => {
      this.subRedis.unsubscribe(channel);
      this.subRedis.removeListener('message', handler);
    };
  }

  // ========== Lifecycle ==========

  /**
   * Health check - ping Redis.
   */
  async ping() {
    const result = await this.redis.ping();
    return result === 'PONG';
  }

  /**
   * Gracefully close all Redis connections.
   */
  async close() {
    await Promise.all([
      this.redis.quit(),
      this.blockingRedis.quit(),
      this.subRedis.quit(),
      this.pubRedis.quit(),
    ]);
  }
}
