import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// We need to mock fs before importing the module, but the module registers
// providers at import time using process.env. We'll test the public API
// by manipulating process.env before each test.

// Dynamic import to allow env manipulation per test
let discoverCredentials, buildClaudeEnv, credentialStatus, registerProvider;

async function loadModule() {
  // Clear module cache by using a unique query param
  const mod = await import(`../src/credentials.js?t=${Date.now()}`);
  return mod;
}

describe('credentials', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset env to a clean state
    process.env = { ...originalEnv };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.CLAUDE_CODE_USE_VERTEX;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // Since the module registers providers at import time and we can't easily
  // re-import with fresh state, we'll test the functions with the singleton
  // provider list. Import once at the top level.
  describe('discoverCredentials', () => {
    it('should return api-key provider when ANTHROPIC_API_KEY is set', async () => {
      const { discoverCredentials } = await import('../src/credentials.js');
      process.env.ANTHROPIC_API_KEY = 'sk-test-123';

      const result = await discoverCredentials();
      expect(result.provider).toBe('api-key');
      expect(result.env.ANTHROPIC_API_KEY).toBe('sk-test-123');
    });

    it('should return none when no credentials are available', async () => {
      const { discoverCredentials } = await import('../src/credentials.js');
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CLAUDE_CODE_USE_BEDROCK;
      delete process.env.CLAUDE_CODE_USE_VERTEX;

      const result = await discoverCredentials();
      expect(result.provider).toBe('none');
      expect(result.env).toEqual({});
    });

    it('should detect bedrock when CLAUDE_CODE_USE_BEDROCK=1', async () => {
      const { discoverCredentials } = await import('../src/credentials.js');
      process.env.CLAUDE_CODE_USE_BEDROCK = '1';
      process.env.AWS_REGION = 'us-east-1';

      const result = await discoverCredentials();
      expect(result.provider).toBe('bedrock');
      expect(result.env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
      expect(result.env.AWS_REGION).toBe('us-east-1');
    });

    it('should detect vertex when CLAUDE_CODE_USE_VERTEX=true', async () => {
      const { discoverCredentials } = await import('../src/credentials.js');
      process.env.CLAUDE_CODE_USE_VERTEX = 'true';
      process.env.GOOGLE_CLOUD_PROJECT = 'my-project';

      const result = await discoverCredentials();
      expect(result.provider).toBe('vertex');
      expect(result.env.CLAUDE_CODE_USE_VERTEX).toBe('1');
      expect(result.env.GOOGLE_CLOUD_PROJECT).toBe('my-project');
    });

    it('should prefer api-key over bedrock (lower priority number)', async () => {
      const { discoverCredentials } = await import('../src/credentials.js');
      process.env.ANTHROPIC_API_KEY = 'sk-test-123';
      process.env.CLAUDE_CODE_USE_BEDROCK = '1';

      const result = await discoverCredentials();
      expect(result.provider).toBe('api-key');
    });
  });

  describe('buildClaudeEnv', () => {
    it('should merge credential env with process.env', async () => {
      const { buildClaudeEnv } = await import('../src/credentials.js');
      process.env.ANTHROPIC_API_KEY = 'sk-test-456';
      process.env.GITHUB_TOKEN = 'ghp_test';

      const env = await buildClaudeEnv();
      expect(env.ANTHROPIC_API_KEY).toBe('sk-test-456');
      expect(env.GH_TOKEN).toBe('ghp_test');
      expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
    });

    it('should include extra env vars', async () => {
      const { buildClaudeEnv } = await import('../src/credentials.js');
      const env = await buildClaudeEnv({ CUSTOM_VAR: 'hello' });
      expect(env.CUSTOM_VAR).toBe('hello');
    });

    it('should prefer GH_TOKEN fallback from process.env', async () => {
      const { buildClaudeEnv } = await import('../src/credentials.js');
      process.env.GH_TOKEN = 'ghp_fallback';

      const env = await buildClaudeEnv();
      expect(env.GH_TOKEN).toBe('ghp_fallback');
    });
  });

  describe('credentialStatus', () => {
    it('should return status of all providers', async () => {
      const { credentialStatus } = await import('../src/credentials.js');
      process.env.ANTHROPIC_API_KEY = 'sk-test';

      const status = await credentialStatus();
      expect(status.activeProvider).toBe('api-key');
      expect(status.providers).toBeInstanceOf(Array);
      expect(status.providers.length).toBeGreaterThanOrEqual(4);

      const apiKeyProvider = status.providers.find(p => p.name === 'api-key');
      expect(apiKeyProvider.available).toBe(true);

      const bedrockProvider = status.providers.find(p => p.name === 'bedrock');
      expect(bedrockProvider.available).toBe(false);
    });
  });

  describe('registerProvider', () => {
    it('should add custom providers sorted by priority', async () => {
      const { registerProvider, credentialStatus } = await import('../src/credentials.js');

      registerProvider({
        name: 'test-provider',
        priority: 5, // Higher priority than api-key (10)
        detect: async () => true,
        env: async () => ({ TEST_KEY: 'test-value' }),
      });

      const status = await credentialStatus();
      // test-provider should be first since priority 5 < 10
      expect(status.providers[0].name).toBe('test-provider');

      // Clean up: we can't easily unregister, but subsequent tests
      // won't be affected since env won't have ANTHROPIC_API_KEY
    });
  });
});
