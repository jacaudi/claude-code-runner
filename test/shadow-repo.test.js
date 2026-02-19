import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ShadowRepoManager } from '../src/git/shadow-repo.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { mkdir, rm, writeFile } from 'fs/promises';
import path from 'path';

const exec = promisify(execFile);
const SHADOW_DIR = '/tmp/claude-shadows';
const TEST_REPO_DIR = '/tmp/test-shadow-repo';

const GIT = existsSync('/usr/bin/git.real') ? '/usr/bin/git.real' : 'git';

async function createTestRepo() {
  await rm(TEST_REPO_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TEST_REPO_DIR, { recursive: true });

  await exec(GIT, ['init', '--initial-branch=main'], { cwd: TEST_REPO_DIR });
  await exec(GIT, ['config', 'user.email', 'test@test.com'], { cwd: TEST_REPO_DIR });
  await exec(GIT, ['config', 'user.name', 'Test'], { cwd: TEST_REPO_DIR });
  // Disable commit signing — this env may have gpg signing configured
  await exec(GIT, ['config', 'commit.gpgsign', 'false'], { cwd: TEST_REPO_DIR });

  const filePath = path.join(TEST_REPO_DIR, 'README.md');
  await writeFile(filePath, '# Test Repo\n');
  await exec(GIT, ['add', '.'], { cwd: TEST_REPO_DIR });
  await exec(GIT, ['commit', '-m', 'initial commit'], { cwd: TEST_REPO_DIR });

  // Create a task branch
  await exec(GIT, ['checkout', '-b', 'claude/test-task'], { cwd: TEST_REPO_DIR });
  await writeFile(filePath, '# Test Repo\n\nModified by Claude\n');
  await exec(GIT, ['add', '.'], { cwd: TEST_REPO_DIR });
  await exec(GIT, ['commit', '-m', 'feat: add Claude changes'], { cwd: TEST_REPO_DIR });

  return TEST_REPO_DIR;
}

describe('ShadowRepoManager', () => {
  let manager;

  beforeEach(async () => {
    manager = new ShadowRepoManager({ gitBinary: GIT });
    await rm(SHADOW_DIR, { recursive: true, force: true }).catch(() => {});
  });

  afterEach(async () => {
    await manager.cleanup();
    await rm(TEST_REPO_DIR, { recursive: true, force: true }).catch(() => {});
  });

  describe('track', () => {
    it('should create a shadow clone for a local repo', async () => {
      await createTestRepo();

      await manager.track('test-1', TEST_REPO_DIR, 'claude/test-task', 999999);

      const shadowPath = path.join(SHADOW_DIR, 'test-1');
      expect(existsSync(shadowPath)).toBe(true);
    });

    it('should not track the same task twice', async () => {
      await createTestRepo();

      await manager.track('test-1', TEST_REPO_DIR, 'claude/test-task', 999999);
      await manager.track('test-1', TEST_REPO_DIR, 'claude/test-task', 999999);

      expect(manager.tracked.size).toBe(1);
    });

    it('should handle non-existent branch by creating empty bare repo', async () => {
      await createTestRepo();

      await manager.track('test-2', TEST_REPO_DIR, 'nonexistent-branch', 999999);

      const shadowPath = path.join(SHADOW_DIR, 'test-2');
      expect(existsSync(shadowPath)).toBe(true);
    });
  });

  describe('untrack', () => {
    it('should stop tracking and clean up files', async () => {
      await createTestRepo();
      await manager.track('test-1', TEST_REPO_DIR, 'claude/test-task', 999999);

      await manager.untrack('test-1');

      expect(manager.tracked.has('test-1')).toBe(false);
      const shadowPath = path.join(SHADOW_DIR, 'test-1');
      expect(existsSync(shadowPath)).toBe(false);
    });

    it('should handle untracking non-existent task', async () => {
      await manager.untrack('nonexistent');
    });
  });

  describe('getCommits', () => {
    it('should return commits for tracked branch', async () => {
      await createTestRepo();
      await manager.track('test-1', TEST_REPO_DIR, 'claude/test-task', 999999);

      const commits = await manager.getCommits('test-1');

      expect(commits.length).toBeGreaterThanOrEqual(1);
      expect(commits[0]).toHaveProperty('hash');
      expect(commits[0]).toHaveProperty('message');
      expect(commits[0]).toHaveProperty('date');
      expect(commits[0]).toHaveProperty('author');
      expect(commits[0].message).toBe('feat: add Claude changes');
    });

    it('should return empty array for untracked task', async () => {
      const commits = await manager.getCommits('nonexistent');
      expect(commits).toEqual([]);
    });

    it('should handle commit messages with pipe characters', async () => {
      await createTestRepo();
      const filePath = path.join(TEST_REPO_DIR, 'test.txt');
      await writeFile(filePath, 'test');
      await exec(GIT, ['add', '.'], { cwd: TEST_REPO_DIR });
      await exec(GIT, ['commit', '-m', 'fix: handle A | B | C pipe chars'], { cwd: TEST_REPO_DIR });

      await manager.track('test-pipe', TEST_REPO_DIR, 'claude/test-task', 999999);

      const commits = await manager.getCommits('test-pipe');
      const pipeCommit = commits.find(c => c.message.includes('pipe'));
      expect(pipeCommit).toBeDefined();
      expect(pipeCommit.message).toBe('fix: handle A | B | C pipe chars');
    });
  });

  describe('getLatestDiff', () => {
    it('should return diff for latest commit', async () => {
      await createTestRepo();
      await manager.track('test-1', TEST_REPO_DIR, 'claude/test-task', 999999);

      const diff = await manager.getLatestDiff('test-1');

      expect(diff.length).toBeGreaterThanOrEqual(1);
      expect(diff[0]).toHaveProperty('status');
      expect(diff[0]).toHaveProperty('file');
    });

    it('should return empty for untracked task', async () => {
      const diff = await manager.getLatestDiff('nonexistent');
      expect(diff).toEqual([]);
    });
  });

  describe('fetch', () => {
    it('should not throw for tracked task', async () => {
      await createTestRepo();
      await manager.track('test-1', TEST_REPO_DIR, 'claude/test-task', 999999);

      await manager.fetch('test-1');
    });

    it('should not throw for untracked task', async () => {
      await manager.fetch('nonexistent');
    });
  });

  describe('cleanup', () => {
    it('should clean up all tracked repos', async () => {
      await createTestRepo();
      await manager.track('test-1', TEST_REPO_DIR, 'claude/test-task', 999999);

      await manager.cleanup();

      expect(manager.tracked.size).toBe(0);
      expect(existsSync(SHADOW_DIR)).toBe(false);
    });
  });
});
