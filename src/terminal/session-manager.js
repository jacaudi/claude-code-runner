/**
 * Terminal session manager.
 *
 * Tracks active terminal sessions for running tasks, buffers output
 * for reconnection, and multiplexes multiple WebSocket viewers onto
 * a single ProcessHandle.
 *
 * Architecture:
 *   - Each running task can have one terminal session
 *   - Multiple WebSocket clients can attach to the same session
 *   - Output is buffered (FIFO, capped) so reconnecting clients catch up
 *   - In local mode: session attaches directly to the ProcessHandle
 *   - In redis mode: ProcessHandle.write() relays through Redis pub/sub
 */

const MAX_BUFFER_SIZE = 256 * 1024; // 256KB output history

/**
 * @typedef {Object} TerminalSession
 * @property {string} taskId
 * @property {import('../dispatchers/index.js').ProcessHandle} proc
 * @property {Set<import('ws').WebSocket>} clients - Connected WebSocket viewers
 * @property {string} buffer - Output history for reconnection
 * @property {boolean} alive - Whether the process is still running
 */

export class TerminalSessionManager {
  constructor() {
    /** @type {Map<string, TerminalSession>} */
    this.sessions = new Map();
  }

  /**
   * Register a process handle as an attachable terminal session.
   * Called by server.js when a task starts running.
   *
   * @param {string} taskId
   * @param {import('../dispatchers/index.js').ProcessHandle} proc
   */
  register(taskId, proc) {
    if (this.sessions.has(taskId)) return;

    const session = {
      taskId,
      proc,
      clients: new Set(),
      buffer: '',
      alive: true,
    };

    // Stream output to all connected clients and buffer it
    proc.onData((data) => {
      // Append to buffer (FIFO cap)
      session.buffer += data;
      if (session.buffer.length > MAX_BUFFER_SIZE) {
        session.buffer = session.buffer.slice(-MAX_BUFFER_SIZE);
      }

      // Broadcast to all connected WebSocket clients
      for (const ws of session.clients) {
        if (ws.readyState === 1) { // WebSocket.OPEN
          ws.send(JSON.stringify({ type: 'output', data }));
        }
      }
    });

    proc.onExit(({ exitCode }) => {
      session.alive = false;
      // Notify all clients that the process exited
      for (const ws of session.clients) {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'exit', exitCode }));
        }
      }
    });

    this.sessions.set(taskId, session);
  }

  /**
   * Attach a WebSocket client to a task's terminal session.
   * Replays buffered output, then streams live output.
   *
   * @param {string} taskId
   * @param {import('ws').WebSocket} ws
   * @returns {boolean} true if attached successfully
   */
  attach(taskId, ws) {
    const session = this.sessions.get(taskId);
    if (!session) return false;

    session.clients.add(ws);

    // Replay buffered output so the client catches up
    if (session.buffer.length > 0) {
      ws.send(JSON.stringify({ type: 'output', data: session.buffer }));
    }

    // If the process already exited, notify immediately
    if (!session.alive) {
      ws.send(JSON.stringify({ type: 'exit', exitCode: -1 }));
    }

    // Handle incoming messages from this client
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        switch (msg.type) {
          case 'input':
            // Forward keystrokes to the process
            if (session.alive && session.proc.write) {
              session.proc.write(msg.data);
            }
            break;

          case 'resize':
            // Forward terminal resize
            if (session.alive && session.proc.resize) {
              session.proc.resize(msg.cols, msg.rows);
            }
            break;
        }
      } catch {
        // Ignore malformed messages
      }
    });

    // Clean up when client disconnects
    ws.on('close', () => {
      session.clients.delete(ws);
    });

    return true;
  }

  /**
   * Remove a session (task completed or cancelled).
   */
  remove(taskId) {
    const session = this.sessions.get(taskId);
    if (!session) return;

    // Close all client connections
    for (const ws of session.clients) {
      ws.close(1000, 'Session ended');
    }
    session.clients.clear();
    this.sessions.delete(taskId);
  }

  /**
   * Check if a task has an active terminal session.
   */
  has(taskId) {
    return this.sessions.has(taskId);
  }

  /**
   * Get info about a session (for API responses).
   */
  getInfo(taskId) {
    const session = this.sessions.get(taskId);
    if (!session) return null;

    return {
      taskId,
      alive: session.alive,
      viewers: session.clients.size,
      bufferSize: session.buffer.length,
    };
  }

  /**
   * List all active sessions.
   */
  listSessions() {
    return [...this.sessions.keys()].map((id) => this.getInfo(id));
  }

  /**
   * Clean up all sessions.
   */
  cleanup() {
    for (const [taskId] of this.sessions) {
      this.remove(taskId);
    }
  }
}
