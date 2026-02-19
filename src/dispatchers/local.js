import pty from 'node-pty';

/**
 * Dispatches Claude processes locally using node-pty.
 * This is the default dispatcher that runs processes directly on the host.
 */
export class LocalDispatcher {
  /**
   * Spawn a local process via node-pty.
   *
   * @param {string} command - The command to run (e.g. 'claude')
   * @param {string[]} args - Command arguments
   * @param {import('./index.js').SpawnOptions} options
   * @returns {import('./index.js').ProcessHandle}
   */
  spawn(command, args, options) {
    const proc = pty.spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      cols: options.cols || 200,
      rows: options.rows || 50,
    });

    return {
      pid: proc.pid,
      onData: (cb) => proc.onData(cb),
      onExit: (cb) => proc.onExit(cb),
      write: (data) => proc.write(data),
      resize: (cols, rows) => proc.resize(cols, rows),
      kill: () => proc.kill(),
    };
  }
}
