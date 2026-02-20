import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TerminalSessionManager } from '../src/terminal/session-manager.js';
import { EventEmitter } from 'events';

/**
 * Create a mock ProcessHandle that conforms to the interface.
 */
function createMockProc() {
  let dataCallback = null;
  let exitCallback = null;

  return {
    pid: 'mock-123',
    onData: (cb) => { dataCallback = cb; },
    onExit: (cb) => { exitCallback = cb; },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    // Test helpers — emit data/exit from outside
    emitData: (data) => dataCallback?.(data),
    emitExit: (exitCode) => exitCallback?.({ exitCode }),
  };
}

/**
 * Create a mock WebSocket.
 */
function createMockWs() {
  const ws = new EventEmitter();
  ws.readyState = 1; // OPEN
  ws.send = vi.fn();
  ws.close = vi.fn();
  return ws;
}

describe('TerminalSessionManager', () => {
  let manager;

  beforeEach(() => {
    manager = new TerminalSessionManager();
  });

  describe('register', () => {
    it('should register a session for a task', () => {
      const proc = createMockProc();
      manager.register('task-1', proc);
      expect(manager.has('task-1')).toBe(true);
    });

    it('should not overwrite an existing session', () => {
      const proc1 = createMockProc();
      const proc2 = createMockProc();
      manager.register('task-1', proc1);
      manager.register('task-1', proc2);

      // Should still be the first session
      const info = manager.getInfo('task-1');
      expect(info.alive).toBe(true);
    });

    it('should buffer output from the process', () => {
      const proc = createMockProc();
      manager.register('task-1', proc);

      proc.emitData('hello ');
      proc.emitData('world');

      const info = manager.getInfo('task-1');
      expect(info.bufferSize).toBe(11);
    });

    it('should cap the buffer at 256KB', () => {
      const proc = createMockProc();
      manager.register('task-1', proc);

      // Write more than 256KB
      const bigData = 'x'.repeat(300 * 1024);
      proc.emitData(bigData);

      const info = manager.getInfo('task-1');
      expect(info.bufferSize).toBeLessThanOrEqual(256 * 1024);
    });

    it('should broadcast data to connected clients', () => {
      const proc = createMockProc();
      manager.register('task-1', proc);

      const ws = createMockWs();
      manager.attach('task-1', ws);

      // Clear the initial buffer replay send
      ws.send.mockClear();

      proc.emitData('new data');

      expect(ws.send).toHaveBeenCalledTimes(1);
      const msg = JSON.parse(ws.send.mock.calls[0][0]);
      expect(msg.type).toBe('output');
      expect(msg.data).toBe('new data');
    });

    it('should notify clients on process exit', () => {
      const proc = createMockProc();
      manager.register('task-1', proc);

      const ws = createMockWs();
      manager.attach('task-1', ws);
      ws.send.mockClear();

      proc.emitExit(0);

      expect(ws.send).toHaveBeenCalledTimes(1);
      const msg = JSON.parse(ws.send.mock.calls[0][0]);
      expect(msg.type).toBe('exit');
      expect(msg.exitCode).toBe(0);
    });

    it('should mark session as not alive after exit', () => {
      const proc = createMockProc();
      manager.register('task-1', proc);

      proc.emitExit(1);

      const info = manager.getInfo('task-1');
      expect(info.alive).toBe(false);
    });
  });

  describe('attach', () => {
    it('should return false for non-existent sessions', () => {
      const ws = createMockWs();
      expect(manager.attach('nonexistent', ws)).toBe(false);
    });

    it('should replay buffer on attach', () => {
      const proc = createMockProc();
      manager.register('task-1', proc);
      proc.emitData('previous output');

      const ws = createMockWs();
      manager.attach('task-1', ws);

      expect(ws.send).toHaveBeenCalledTimes(1);
      const msg = JSON.parse(ws.send.mock.calls[0][0]);
      expect(msg.type).toBe('output');
      expect(msg.data).toBe('previous output');
    });

    it('should immediately notify if process already exited', () => {
      const proc = createMockProc();
      manager.register('task-1', proc);
      proc.emitExit(42);

      const ws = createMockWs();
      manager.attach('task-1', ws);

      // Should receive exit message (buffer may be empty, so 1 send for exit)
      const calls = ws.send.mock.calls.map(c => JSON.parse(c[0]));
      const exitMsg = calls.find(m => m.type === 'exit');
      expect(exitMsg).toBeDefined();
      expect(exitMsg.exitCode).toBe(-1); // uses -1 for already-exited
    });

    it('should forward input to process write', () => {
      const proc = createMockProc();
      manager.register('task-1', proc);

      const ws = createMockWs();
      manager.attach('task-1', ws);

      // Simulate client sending input
      const inputMsg = JSON.stringify({ type: 'input', data: 'ls\n' });
      ws.emit('message', Buffer.from(inputMsg));

      expect(proc.write).toHaveBeenCalledWith('ls\n');
    });

    it('should forward resize to process', () => {
      const proc = createMockProc();
      manager.register('task-1', proc);

      const ws = createMockWs();
      manager.attach('task-1', ws);

      const resizeMsg = JSON.stringify({ type: 'resize', cols: 120, rows: 40 });
      ws.emit('message', Buffer.from(resizeMsg));

      expect(proc.resize).toHaveBeenCalledWith(120, 40);
    });

    it('should remove client on close', () => {
      const proc = createMockProc();
      manager.register('task-1', proc);

      const ws = createMockWs();
      manager.attach('task-1', ws);

      expect(manager.getInfo('task-1').viewers).toBe(1);

      ws.emit('close');

      expect(manager.getInfo('task-1').viewers).toBe(0);
    });

    it('should support multiple concurrent viewers', () => {
      const proc = createMockProc();
      manager.register('task-1', proc);

      const ws1 = createMockWs();
      const ws2 = createMockWs();
      manager.attach('task-1', ws1);
      manager.attach('task-1', ws2);

      expect(manager.getInfo('task-1').viewers).toBe(2);

      // Both should receive broadcasts
      ws1.send.mockClear();
      ws2.send.mockClear();
      proc.emitData('broadcast');

      expect(ws1.send).toHaveBeenCalledTimes(1);
      expect(ws2.send).toHaveBeenCalledTimes(1);
    });

    it('should ignore malformed messages', () => {
      const proc = createMockProc();
      manager.register('task-1', proc);

      const ws = createMockWs();
      manager.attach('task-1', ws);

      // Should not throw
      ws.emit('message', Buffer.from('not json'));
      ws.emit('message', Buffer.from('{"type":"unknown"}'));
    });
  });

  describe('remove', () => {
    it('should close all client connections', () => {
      const proc = createMockProc();
      manager.register('task-1', proc);

      const ws = createMockWs();
      manager.attach('task-1', ws);

      manager.remove('task-1');

      expect(ws.close).toHaveBeenCalledWith(1000, 'Session ended');
      expect(manager.has('task-1')).toBe(false);
    });

    it('should handle removing non-existent session', () => {
      // Should not throw
      manager.remove('nonexistent');
    });
  });

  describe('getInfo', () => {
    it('should return null for non-existent session', () => {
      expect(manager.getInfo('nonexistent')).toBeNull();
    });

    it('should return correct session info', () => {
      const proc = createMockProc();
      manager.register('task-1', proc);
      proc.emitData('some output');

      const info = manager.getInfo('task-1');
      expect(info).toEqual({
        taskId: 'task-1',
        alive: true,
        viewers: 0,
        bufferSize: 11,
      });
    });
  });

  describe('listSessions', () => {
    it('should list all active sessions', () => {
      manager.register('task-1', createMockProc());
      manager.register('task-2', createMockProc());

      const sessions = manager.listSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions.map(s => s.taskId).sort()).toEqual(['task-1', 'task-2']);
    });
  });

  describe('cleanup', () => {
    it('should remove all sessions', () => {
      manager.register('task-1', createMockProc());
      manager.register('task-2', createMockProc());

      const ws = createMockWs();
      manager.attach('task-1', ws);

      manager.cleanup();

      expect(manager.has('task-1')).toBe(false);
      expect(manager.has('task-2')).toBe(false);
      expect(ws.close).toHaveBeenCalled();
    });
  });
});
