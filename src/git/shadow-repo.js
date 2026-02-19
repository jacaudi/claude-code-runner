import { mkdir, rm, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const exec = promisify(execFile);

// Default to git.real (Docker container) with fallback to git
const DEFAULT_GIT = existsSync('/usr/bin/git.real') ? '/usr/bin/git.real' : 'git';
const SHADOW_DIR = '/tmp/claude-shadows';

/**
 * Shadow repository manager.
 *
 * Maintains lightweight clones of task branches on the API server pod,
 * providing visibility into worker progress without entering the worker's
 * container. The dashboard can query these for diffs, file lists, and
 * commit history.
 *
 * Architecture:
 *   Worker pod pushes commits → GitHub → API pod fetches into shadow clone
 *
 * Each task gets a bare clone at /tmp/claude-shadows/<taskId>/
 * that periodically fetches from origin to stay current.
 */
export class ShadowRepoManager {
  /**
   * @param {Object} [options]
   * @param {string} [options.gitBinary] - Path to git binary (defaults to git.real or git)
   */
  constructor(options = {}) {
    /** @type {Map<string, {repoUrl: string, branch: string, interval: NodeJS.Timeout|null}>} */
    this.tracked = new Map();
    this.git = options.gitBinary || DEFAULT_GIT;
  }

  /**
   * Start tracking a task's branch.
   * Creates a shallow clone and begins periodic fetching.
   *
   * @param {string} taskId
   * @param {string} repoUrl - HTTPS clone URL (token injected by caller)
   * @param {string} branch - Branch name to track (e.g. claude/abc123)
   * @param {number} [intervalMs=15000] - Fetch interval in ms
   */
  async track(taskId, repoUrl, branch, intervalMs = 15000) {
    if (this.tracked.has(taskId)) return;

    const shadowPath = path.join(SHADOW_DIR, taskId);
    await mkdir(shadowPath, { recursive: true });

    try {
      // Shallow clone just the task branch (minimal data transfer)
      await exec(this.git, [
        'clone',
        '--bare',
        '--single-branch',
        '--branch', branch,
        '--depth', '50',
        repoUrl,
        shadowPath,
      ], { timeout: 60000 });
    } catch (err) {
      // Branch might not exist yet (orchestrator hasn't pushed).
      // Create an empty bare repo and set up the remote for later fetching.
      await exec(this.git, ['init', '--bare', shadowPath]);
      await exec(this.git, ['remote', 'add', 'origin', repoUrl], { cwd: shadowPath });
    }

    const entry = { repoUrl, branch, interval: null };

    // Periodic fetch
    entry.interval = setInterval(async () => {
      try {
        await exec(this.git, ['fetch', 'origin', branch, '--depth', '50'], {
          cwd: shadowPath,
          timeout: 30000,
        });
      } catch {
        // Branch may not exist yet or network hiccup - swallow
      }
    }, intervalMs);

    this.tracked.set(taskId, entry);
  }

  /**
   * Stop tracking a task and clean up its shadow clone.
   */
  async untrack(taskId) {
    const entry = this.tracked.get(taskId);
    if (!entry) return;

    if (entry.interval) clearInterval(entry.interval);
    this.tracked.delete(taskId);

    const shadowPath = path.join(SHADOW_DIR, taskId);
    await rm(shadowPath, { recursive: true, force: true }).catch(() => {});
  }

  /**
   * Get the commit log for a tracked task's branch.
   *
   * @param {string} taskId
   * @param {number} [maxCount=20]
   * @returns {Promise<Array<{hash: string, message: string, date: string, author: string}>>}
   */
  async getCommits(taskId, maxCount = 20) {
    const entry = this.tracked.get(taskId);
    if (!entry) return [];

    const shadowPath = path.join(SHADOW_DIR, taskId);
    if (!existsSync(shadowPath)) return [];

    try {
      const { stdout } = await exec(this.git, [
        'log',
        `refs/heads/${entry.branch}`,
        `--max-count=${maxCount}`,
        '--format=%H%x00%s%x00%aI%x00%an',
      ], { cwd: shadowPath, timeout: 5000 });

      return stdout.trim().split('\n').filter(Boolean).map(line => {
        const [hash, message, date, author] = line.split('\0');
        return { hash, message, date, author };
      });
    } catch {
      return [];
    }
  }

  /**
   * Get a diff summary (files changed) for the most recent commit.
   *
   * @param {string} taskId
   * @returns {Promise<Array<{status: string, file: string}>>}
   */
  async getLatestDiff(taskId) {
    const entry = this.tracked.get(taskId);
    if (!entry) return [];

    const shadowPath = path.join(SHADOW_DIR, taskId);
    if (!existsSync(shadowPath)) return [];

    try {
      const { stdout } = await exec(this.git, [
        'diff', '--name-status',
        `refs/heads/${entry.branch}~1`,
        `refs/heads/${entry.branch}`,
      ], { cwd: shadowPath, timeout: 5000 });

      return stdout.trim().split('\n').filter(Boolean).map(line => {
        const [status, ...fileParts] = line.split('\t');
        return { status, file: fileParts.join('\t') };
      });
    } catch {
      return [];
    }
  }

  /**
   * Get cumulative diff stats (insertions/deletions) for the task branch
   * compared to its parent branch.
   *
   * @param {string} taskId
   * @returns {Promise<{files: number, insertions: number, deletions: number}|null>}
   */
  async getDiffStats(taskId) {
    const entry = this.tracked.get(taskId);
    if (!entry) return null;

    const shadowPath = path.join(SHADOW_DIR, taskId);
    if (!existsSync(shadowPath)) return null;

    try {
      const { stdout } = await exec(this.git, [
        'diff', '--stat',
        `refs/heads/${entry.branch}`,
        '--', // separator
      ], { cwd: shadowPath, timeout: 5000 });

      // Parse the summary line: " 5 files changed, 120 insertions(+), 30 deletions(-)"
      const summary = stdout.trim().split('\n').pop() || '';
      const files = parseInt(summary.match(/(\d+) files? changed/)?.[1] || '0');
      const insertions = parseInt(summary.match(/(\d+) insertions?/)?.[1] || '0');
      const deletions = parseInt(summary.match(/(\d+) deletions?/)?.[1] || '0');

      return { files, insertions, deletions };
    } catch {
      return null;
    }
  }

  /**
   * Force an immediate fetch for a tracked task.
   */
  async fetch(taskId) {
    const entry = this.tracked.get(taskId);
    if (!entry) return;

    const shadowPath = path.join(SHADOW_DIR, taskId);
    try {
      await exec(this.git, ['fetch', 'origin', entry.branch, '--depth', '50'], {
        cwd: shadowPath,
        timeout: 30000,
      });
    } catch {
      // swallow
    }
  }

  /**
   * Clean up all shadow repos and stop all intervals.
   */
  async cleanup() {
    for (const [taskId] of this.tracked) {
      await this.untrack(taskId);
    }
    await rm(SHADOW_DIR, { recursive: true, force: true }).catch(() => {});
  }
}
