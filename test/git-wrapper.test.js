import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, readFile, rm, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const exec = promisify(execFile);

const WRAPPER_SRC = '/home/user/claude-code-runner/docker/git-wrapper.sh';
const WRAPPER = '/tmp/test-git-wrapper.sh';
const SENTINEL = '/tmp/.branch-created';
const TEST_DIR = '/tmp/test-git-wrapper';

const GIT_REAL = existsSync('/usr/bin/git.real') ? '/usr/bin/git.real' : '/usr/bin/git';

/**
 * Create a test-compatible copy of the git wrapper that uses the real git path
 * for this environment (in Docker it's git.real, outside it's just git).
 */
async function createTestWrapper() {
  let script = await readFile(WRAPPER_SRC, 'utf-8');
  // Replace hardcoded /usr/bin/git.real with the available git binary
  script = script.replace(/\/usr\/bin\/git\.real/g, GIT_REAL);
  await writeFile(WRAPPER, script, { mode: 0o755 });
}

async function runWrapper(...args) {
  try {
    const { stdout, stderr } = await exec('bash', [WRAPPER, ...args], {
      cwd: TEST_DIR,
      timeout: 5000,
      env: { ...process.env, PATH: '/usr/bin:/bin:/usr/local/bin' },
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.code || 1,
    };
  }
}

describe('git-wrapper.sh', () => {
  beforeAll(async () => {
    await createTestWrapper();
  });

  afterAll(async () => {
    await rm(WRAPPER, { force: true }).catch(() => {});
  });

  beforeEach(async () => {
    await rm(SENTINEL, { force: true }).catch(() => {});
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
    await mkdir(TEST_DIR, { recursive: true });

    await exec(GIT_REAL, ['init', '--initial-branch=main'], { cwd: TEST_DIR });
    await exec(GIT_REAL, ['config', 'user.email', 'test@test.com'], { cwd: TEST_DIR });
    await exec(GIT_REAL, ['config', 'user.name', 'Test'], { cwd: TEST_DIR });
    await exec(GIT_REAL, ['config', 'commit.gpgsign', 'false'], { cwd: TEST_DIR });
    await writeFile(path.join(TEST_DIR, 'file.txt'), 'hello');
    await exec(GIT_REAL, ['add', '.'], { cwd: TEST_DIR });
    await exec(GIT_REAL, ['commit', '-m', 'initial'], { cwd: TEST_DIR });
  });

  afterEach(async () => {
    await rm(SENTINEL, { force: true }).catch(() => {});
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  describe('before sentinel (initial setup phase)', () => {
    it('should allow all git commands before branch creation', async () => {
      const result = await runWrapper('status');
      expect(result.exitCode).toBe(0);
    });

    it('should create sentinel on checkout -b', async () => {
      expect(existsSync(SENTINEL)).toBe(false);

      await runWrapper('checkout', '-b', 'claude/test');

      expect(existsSync(SENTINEL)).toBe(true);
    });

    it('should create sentinel on switch -c', async () => {
      expect(existsSync(SENTINEL)).toBe(false);

      await runWrapper('switch', '-c', 'claude/test');

      expect(existsSync(SENTINEL)).toBe(true);
    });

    it('should allow checkout to existing branch before sentinel', async () => {
      await exec(GIT_REAL, ['branch', 'feature'], { cwd: TEST_DIR });

      const result = await runWrapper('checkout', 'feature');
      expect(result.exitCode).toBe(0);
    });
  });

  describe('after sentinel (locked to task branch)', () => {
    beforeEach(async () => {
      await writeFile(SENTINEL, '');
      await exec(GIT_REAL, ['checkout', '-b', 'claude/task'], { cwd: TEST_DIR });
    });

    it('should block checkout to existing branch', async () => {
      const result = await runWrapper('checkout', 'main');
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Branch switching is blocked');
    });

    it('should block switch to existing branch', async () => {
      const result = await runWrapper('switch', 'main');
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Branch switching is blocked');
    });

    it('should allow checkout -b (new branch)', async () => {
      const result = await runWrapper('checkout', '-b', 'claude/new-branch');
      expect(result.exitCode).toBe(0);
    });

    it('should allow checkout -B (force new branch)', async () => {
      const result = await runWrapper('checkout', '-B', 'claude/force-branch');
      expect(result.exitCode).toBe(0);
    });

    it('should allow switch -c (new branch)', async () => {
      const result = await runWrapper('switch', '-c', 'claude/new-switch');
      expect(result.exitCode).toBe(0);
    });

    it('should allow switch -C (force new branch)', async () => {
      const result = await runWrapper('switch', '-C', 'claude/force-switch');
      expect(result.exitCode).toBe(0);
    });

    it('should allow checkout -- <file> (file restore)', async () => {
      await writeFile(path.join(TEST_DIR, 'file.txt'), 'modified');

      const result = await runWrapper('checkout', '--', 'file.txt');
      expect(result.exitCode).toBe(0);
    });

    it('should allow checkout for existing file paths', async () => {
      await writeFile(path.join(TEST_DIR, 'file.txt'), 'modified');

      // File exists on disk — wrapper should detect it and allow
      const result = await runWrapper('checkout', 'file.txt');
      expect(result.exitCode).toBe(0);
    });

    it('should allow non-checkout commands', async () => {
      const statusResult = await runWrapper('status');
      expect(statusResult.exitCode).toBe(0);

      const logResult = await runWrapper('log', '--oneline', '-1');
      expect(logResult.exitCode).toBe(0);

      const diffResult = await runWrapper('diff');
      expect(diffResult.exitCode).toBe(0);
    });

    it('should allow git add and commit', async () => {
      await writeFile(path.join(TEST_DIR, 'new-file.txt'), 'content');
      const addResult = await runWrapper('add', 'new-file.txt');
      expect(addResult.exitCode).toBe(0);

      const commitResult = await runWrapper('commit', '-m', 'add new file');
      expect(commitResult.exitCode).toBe(0);
    });
  });
});
