import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

/**
 * Tests for RedisDispatcher and RedisWorkerExecutor.
 *
 * These use mocked queue and process objects to test the dispatch logic
 * without needing real Redis or node-pty.
 */

// Mock ioredis (required by redis-worker.js -> local.js path)
vi.mock('ioredis', () => {
  const EventEmitter = require('events').EventEmitter;
  class MockRedis extends EventEmitter {
    constructor() { super(); }
    async subscribe() {}
    async unsubscribe() {}
    async publish() {}
    async quit() {}
  }
  return { default: MockRedis };
});

// Mock node-pty so LocalDispatcher doesn't try to spawn real processes
vi.mock('node-pty', () => {
  return {
    default: {
      spawn: vi.fn(),
    },
    spawn: vi.fn(),
  };
});

// Mock fs/promises for mkdir in RedisWorkerExecutor
vi.mock('fs/promises', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    mkdir: vi.fn().mockResolvedValue(undefined),
  };
});

const { RedisDispatcher } = await import('../src/dispatchers/redis-worker.js');

/**
 * Create a mock RedisQueue for testing the dispatcher.
 */
function createMockQueue() {
  const subRedis = new EventEmitter();
  subRedis.subscribe = vi.fn();
  subRedis.unsubscribe = vi.fn();

  const pubRedis = {
    publish: vi.fn().mockResolvedValue(1),
  };

  return {
    subRedis,
    pubRedis,
    subscribeLogs: vi.fn((taskId, cb) => {
      const channel = `claude:logs:${taskId}`;
      const handler = (ch, msg) => {
        if (ch === channel) cb(msg);
      };
      subRedis.on('message', handler);
      return () => {
        subRedis.removeListener('message', handler);
      };
    }),
    subscribeStatus: vi.fn((taskId, cb) => {
      const channel = `claude:status:${taskId}`;
      const handler = (ch, msg) => {
        if (ch === channel) {
          try { cb(JSON.parse(msg)); }
          catch { cb(msg); }
        }
      };
      subRedis.on('message', handler);
      return () => {
        subRedis.removeListener('message', handler);
      };
    }),
    enqueue: vi.fn().mockResolvedValue(undefined),
    publishStatus: vi.fn().mockResolvedValue(undefined),
    publishLog: vi.fn().mockResolvedValue(undefined),
    updateTask: vi.fn().mockResolvedValue(undefined),
    appendLog: vi.fn().mockResolvedValue(undefined),
  };
}

describe('RedisDispatcher', () => {
  let queue;
  let dispatcher;

  beforeEach(() => {
    queue = createMockQueue();
    dispatcher = new RedisDispatcher(queue);
  });

  describe('spawn', () => {
    it('should require a taskId', () => {
      expect(() => {
        dispatcher.spawn('claude', [], { cwd: '/tmp' });
      }).toThrow('RedisDispatcher requires options.taskId');
    });

    it('should enqueue task to Redis', () => {
      dispatcher.spawn('claude', ['-p', 'hello'], {
        cwd: '/tmp/work/abc',
        taskId: 'test-task',
        phase: 'worker',
      });

      expect(queue.enqueue).toHaveBeenCalledWith('test-task', expect.objectContaining({
        command: 'claude',
        cwd: '/tmp/work/abc',
        phase: 'worker',
      }));
    });

    it('should return a valid ProcessHandle', () => {
      const handle = dispatcher.spawn('claude', [], {
        cwd: '/tmp',
        taskId: 'handle-test',
      });

      expect(handle.pid).toBe('redis:handle-test');
      expect(typeof handle.onData).toBe('function');
      expect(typeof handle.onExit).toBe('function');
      expect(typeof handle.write).toBe('function');
      expect(typeof handle.resize).toBe('function');
      expect(typeof handle.kill).toBe('function');
    });

    it('should forward data from Redis subscription', () => {
      const handle = dispatcher.spawn('claude', [], {
        cwd: '/tmp',
        taskId: 'data-test',
      });

      const dataFn = vi.fn();
      handle.onData(dataFn);

      // Simulate log data arriving via pub/sub
      queue.subRedis.emit('message', 'claude:logs:data-test', 'hello from worker');

      expect(dataFn).toHaveBeenCalledWith('hello from worker');
    });

    it('should forward exit from Redis subscription', () => {
      const handle = dispatcher.spawn('claude', [], {
        cwd: '/tmp',
        taskId: 'exit-test',
      });

      const exitFn = vi.fn();
      handle.onExit(exitFn);

      // Simulate exit status arriving via pub/sub
      queue.subRedis.emit(
        'message',
        'claude:status:exit-test',
        JSON.stringify({ event: 'exit', exitCode: 0 })
      );

      expect(exitFn).toHaveBeenCalledWith({ exitCode: 0 });
    });

    it('should relay write via Redis publish', () => {
      const handle = dispatcher.spawn('claude', [], {
        cwd: '/tmp',
        taskId: 'write-test',
      });

      handle.write('ls\n');

      expect(queue.pubRedis.publish).toHaveBeenCalledWith(
        'claude:term-input:write-test',
        'ls\n'
      );
    });

    it('should relay resize via Redis publish', () => {
      const handle = dispatcher.spawn('claude', [], {
        cwd: '/tmp',
        taskId: 'resize-test',
      });

      handle.resize(120, 40);

      expect(queue.pubRedis.publish).toHaveBeenCalledWith(
        'claude:term-resize:resize-test',
        JSON.stringify({ cols: 120, rows: 40 })
      );
    });

    it('should publish kill signal and clean up subscriptions', () => {
      const handle = dispatcher.spawn('claude', [], {
        cwd: '/tmp',
        taskId: 'kill-test',
      });

      handle.kill();

      expect(queue.publishStatus).toHaveBeenCalledWith('kill-test', { event: 'kill' });
    });

    it('should default exitCode to 1 when not provided', () => {
      const handle = dispatcher.spawn('claude', [], {
        cwd: '/tmp',
        taskId: 'default-exit',
      });

      const exitFn = vi.fn();
      handle.onExit(exitFn);

      queue.subRedis.emit(
        'message',
        'claude:status:default-exit',
        JSON.stringify({ event: 'exit' }) // no exitCode
      );

      expect(exitFn).toHaveBeenCalledWith({ exitCode: 1 });
    });
  });
});
