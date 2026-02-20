import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Tests for RedisQueue using mocked Redis clients.
 *
 * All MockRedis instances share a single backing store so that data written
 * via queue.redis is visible from queue.blockingRedis, matching real Redis.
 */

// Shared state across all MockRedis instances (simulates a single Redis server)
let sharedData, sharedLists;

vi.mock('ioredis', () => {
  const EventEmitter = require('events').EventEmitter;

  class MockRedis extends EventEmitter {
    constructor() {
      super();
      // All instances share the same Maps
      this.data = sharedData;
      this.lists = sharedLists;
    }

    async hset(key, obj) {
      const existing = this.data.get(key) || {};
      Object.assign(existing, obj);
      this.data.set(key, existing);
    }

    async hgetall(key) {
      return this.data.get(key) || {};
    }

    async expire() {}

    async lpush(key, value) {
      const list = this.lists.get(key) || [];
      list.unshift(value);
      this.lists.set(key, list);
    }

    async brpop(key, timeout) {
      const list = this.lists.get(key) || [];
      if (list.length === 0) return null;
      return [key, list.pop()];
    }

    async publish() { return 1; }
    async subscribe() {}
    async unsubscribe() {}

    async append(key, value) {
      const existing = this.data.get(key) || '';
      this.data.set(key, existing + value);
    }

    async get(key) {
      return this.data.get(key) || null;
    }

    async scan(cursor, ...args) {
      const matchIdx = args.indexOf('MATCH');
      const pattern = matchIdx >= 0 ? args[matchIdx + 1] : '*';
      const prefix = pattern.replace('*', '');
      const keys = [...this.data.keys()].filter(k => k.startsWith(prefix));
      return ['0', keys];
    }

    async ping() { return 'PONG'; }
    async quit() {}

    on(event, handler) {
      super.on(event, handler);
      return this;
    }
  }

  return { default: MockRedis };
});

const { RedisQueue } = await import('../src/queue/redis.js');

describe('RedisQueue', () => {
  let queue;

  beforeEach(() => {
    // Reset shared state before each test
    sharedData = new Map();
    sharedLists = new Map();
    queue = new RedisQueue('redis://localhost:6379');
  });

  describe('task state', () => {
    it('should set and get a task', async () => {
      await queue.setTask('task-1', {
        status: 'running',
        prompt: 'test prompt',
        started: '2024-01-01T00:00:00Z',
      });

      const task = await queue.getTask('task-1');
      expect(task).toEqual({
        status: 'running',
        prompt: 'test prompt',
        started: '2024-01-01T00:00:00Z',
      });
    });

    it('should return null for non-existent task', async () => {
      const task = await queue.getTask('nonexistent');
      expect(task).toBeNull();
    });

    it('should convert null/undefined values to empty strings and back', async () => {
      await queue.setTask('task-2', {
        status: 'completed',
        pr_url: null,
        error: undefined,
      });

      const task = await queue.getTask('task-2');
      expect(task.pr_url).toBeNull();
      expect(task.error).toBeNull();
    });

    it('should update specific fields on a task', async () => {
      await queue.setTask('task-3', {
        status: 'running',
        prompt: 'hello',
      });

      await queue.updateTask('task-3', {
        status: 'completed',
        finished: '2024-01-01T01:00:00Z',
      });

      const task = await queue.getTask('task-3');
      expect(task.status).toBe('completed');
      expect(task.prompt).toBe('hello');
      // 'finished' has a real value so it should NOT be converted to null
      expect(task.finished).toBe('2024-01-01T01:00:00Z');
    });
  });

  describe('enqueue/dequeue', () => {
    it('should enqueue and dequeue a task', async () => {
      await queue.enqueue('task-10', {
        command: 'claude',
        args: '[]',
        cwd: '/tmp/work',
      });

      const task = await queue.dequeue(1);
      expect(task).not.toBeNull();
      expect(task.id).toBe('task-10');
      expect(task.command).toBe('claude');
      expect(task.status).toBe('queued');
    });

    it('should return null on empty queue', async () => {
      const task = await queue.dequeue(1);
      expect(task).toBeNull();
    });

    it('should dequeue in FIFO order', async () => {
      await queue.enqueue('first', { command: 'a' });
      await queue.enqueue('second', { command: 'b' });

      const task1 = await queue.dequeue(1);
      const task2 = await queue.dequeue(1);

      expect(task1.id).toBe('first');
      expect(task2.id).toBe('second');
    });
  });

  describe('log streaming', () => {
    it('should append and retrieve log buffer', async () => {
      await queue.appendLog('task-20', 'line 1\n');
      await queue.appendLog('task-20', 'line 2\n');

      const buffer = await queue.getLogBuffer('task-20');
      expect(buffer).toBe('line 1\nline 2\n');
    });

    it('should return empty string for missing log buffer', async () => {
      const buffer = await queue.getLogBuffer('nonexistent');
      expect(buffer).toBe('');
    });
  });

  describe('pub/sub', () => {
    it('should subscribe to log channels', () => {
      const callback = vi.fn();
      const unsub = queue.subscribeLogs('task-30', callback);

      queue.subRedis.emit('message', 'claude:logs:task-30', 'hello world');

      expect(callback).toHaveBeenCalledWith('hello world');

      unsub();

      queue.subRedis.emit('message', 'claude:logs:task-30', 'after unsub');
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should subscribe to status channels', () => {
      const callback = vi.fn();
      const unsub = queue.subscribeStatus('task-31', callback);

      queue.subRedis.emit('message', 'claude:status:task-31', JSON.stringify({ event: 'exit', exitCode: 0 }));

      expect(callback).toHaveBeenCalledWith({ event: 'exit', exitCode: 0 });

      unsub();
    });

    it('should ignore messages for other channels', () => {
      const callback = vi.fn();
      queue.subscribeLogs('task-32', callback);

      queue.subRedis.emit('message', 'claude:logs:other-task', 'wrong task');

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('listTasks', () => {
    it('should list all tasks sorted by start time', async () => {
      await queue.setTask('old', { status: 'completed', started: '2024-01-01T00:00:00Z' });
      await queue.setTask('new', { status: 'running', started: '2024-06-01T00:00:00Z' });

      const tasks = await queue.listTasks();
      expect(tasks).toHaveLength(2);
      expect(tasks[0].id).toBe('new');
      expect(tasks[1].id).toBe('old');
    });
  });

  describe('ping', () => {
    it('should return true on successful ping', async () => {
      const ok = await queue.ping();
      expect(ok).toBe(true);
    });
  });

  describe('close', () => {
    it('should close all Redis connections', async () => {
      const quitSpy1 = vi.spyOn(queue.redis, 'quit');
      const quitSpy2 = vi.spyOn(queue.blockingRedis, 'quit');
      const quitSpy3 = vi.spyOn(queue.subRedis, 'quit');
      const quitSpy4 = vi.spyOn(queue.pubRedis, 'quit');

      await queue.close();

      expect(quitSpy1).toHaveBeenCalled();
      expect(quitSpy2).toHaveBeenCalled();
      expect(quitSpy3).toHaveBeenCalled();
      expect(quitSpy4).toHaveBeenCalled();
    });
  });
});
