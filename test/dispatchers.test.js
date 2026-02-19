import { describe, it, expect, vi } from 'vitest';

/**
 * Tests for the dispatcher factory and interface compliance.
 */

// Mock node-pty
vi.mock('node-pty', () => {
  const EventEmitter = require('events').EventEmitter;
  return {
    default: {
      spawn: vi.fn(() => {
        const emitter = new EventEmitter();
        return {
          pid: 42,
          onData: (cb) => emitter.on('data', cb),
          onExit: (cb) => emitter.on('exit', (e) => cb(e)),
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
        };
      }),
    },
  };
});

// Mock @kubernetes/client-node with proper function stubs
vi.mock('@kubernetes/client-node', () => {
  function KubeConfig() {
    this.loadFromDefault = vi.fn();
    this.makeApiClient = vi.fn(() => ({
      createNamespacedJob: vi.fn().mockResolvedValue({}),
      readNamespacedJob: vi.fn().mockResolvedValue({ status: {} }),
      deleteNamespacedJob: vi.fn().mockResolvedValue({}),
      listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
    }));
  }
  function BatchV1Api() {}
  function CoreV1Api() {}
  function Log() {
    this.log = vi.fn().mockResolvedValue({});
  }
  return { KubeConfig, BatchV1Api, CoreV1Api, Log };
});

// Mock ioredis
vi.mock('ioredis', () => {
  const EventEmitter = require('events').EventEmitter;
  class MockRedis extends EventEmitter {
    constructor() { super(); }
    on(event, handler) { super.on(event, handler); return this; }
    async subscribe() {}
    async unsubscribe() {}
    async publish() {}
    async quit() {}
  }
  return { default: MockRedis };
});

const { createDispatcher, LocalDispatcher, KubernetesDispatcher, RedisDispatcher } = await import('../src/dispatchers/index.js');

describe('createDispatcher', () => {
  it('should create LocalDispatcher by default', () => {
    const d = createDispatcher('local');
    expect(d).toBeInstanceOf(LocalDispatcher);
  });

  it('should create KubernetesDispatcher for kubernetes mode', () => {
    const d = createDispatcher('kubernetes');
    expect(d).toBeInstanceOf(KubernetesDispatcher);
  });

  it('should create RedisDispatcher for redis mode', () => {
    const mockQueue = {
      subscribeLogs: vi.fn(),
      subscribeStatus: vi.fn(),
      enqueue: vi.fn(),
      publishStatus: vi.fn(),
      subRedis: { on: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(), removeListener: vi.fn() },
      pubRedis: { publish: vi.fn() },
    };
    const d = createDispatcher('redis', { redisQueue: mockQueue });
    expect(d).toBeInstanceOf(RedisDispatcher);
  });

  it('should throw for redis mode without queue', () => {
    expect(() => createDispatcher('redis')).toThrow('requires a RedisQueue instance');
  });

  it('should throw for unknown mode', () => {
    expect(() => createDispatcher('docker-swarm')).toThrow('Unknown DISPATCH_MODE');
  });
});

describe('LocalDispatcher ProcessHandle interface', () => {
  it('should return a handle with all required methods', () => {
    const d = new LocalDispatcher();

    const handle = d.spawn('echo', ['hello'], {
      cwd: '/tmp',
      env: {},
    });

    expect(handle).toHaveProperty('pid');
    expect(typeof handle.onData).toBe('function');
    expect(typeof handle.onExit).toBe('function');
    expect(typeof handle.write).toBe('function');
    expect(typeof handle.resize).toBe('function');
    expect(typeof handle.kill).toBe('function');
  });
});

describe('KubernetesDispatcher ProcessHandle interface', () => {
  it('should return a handle with all required methods including write/resize', () => {
    const d = new KubernetesDispatcher({ namespace: 'default', image: 'test' });

    const handle = d.spawn('echo', ['hello'], {
      cwd: '/tmp',
      env: {},
    });

    expect(handle).toHaveProperty('pid');
    expect(typeof handle.onData).toBe('function');
    expect(typeof handle.onExit).toBe('function');
    expect(typeof handle.write).toBe('function');
    expect(typeof handle.resize).toBe('function');
    expect(typeof handle.kill).toBe('function');
  });
});
