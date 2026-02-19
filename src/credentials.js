import { readFile, access } from 'fs/promises';
import { existsSync } from 'fs';

/**
 * Multi-provider credential discovery for Claude Code.
 *
 * Uses an extensible provider registry. Each provider has a detect() function
 * that checks if credentials are available, and an env() function that returns
 * the env vars needed for Claude. Providers are tried in priority order.
 *
 * To add a new provider:
 *   import { registerProvider } from './credentials.js';
 *   registerProvider({ name: 'my-provider', priority: 25, detect, env });
 */

const CREDENTIALS_PATH = '/home/node/.claude/.credentials.json';

/**
 * @typedef {Object} CredentialProvider
 * @property {string} name - Provider identifier (e.g. 'api-key', 'oauth')
 * @property {number} priority - Lower = higher priority (tried first)
 * @property {function(): Promise<boolean>} detect - Returns true if credentials are available
 * @property {function(): Promise<Record<string, string>>} env - Returns env vars for Claude
 */

/** @type {CredentialProvider[]} */
const providers = [];

/**
 * Register a credential provider.
 * Providers are sorted by priority (lower = tried first).
 *
 * @param {CredentialProvider} provider
 */
export function registerProvider(provider) {
  providers.push(provider);
  providers.sort((a, b) => a.priority - b.priority);
}

// ============ Built-in Providers ============

// 1. Direct API key (highest priority)
registerProvider({
  name: 'api-key',
  priority: 10,
  detect: async () => !!process.env.ANTHROPIC_API_KEY,
  env: async () => ({
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  }),
});

// 2. OAuth credentials file
registerProvider({
  name: 'oauth',
  priority: 20,
  detect: async () => {
    try {
      await access(CREDENTIALS_PATH);
      const raw = await readFile(CREDENTIALS_PATH, 'utf-8');
      const creds = JSON.parse(raw);
      return !!(creds && (creds.claudeAiOauth || creds.oauthToken));
    } catch {
      return false;
    }
  },
  env: async () => ({}), // Claude Code reads the file directly
});

// 3. AWS Bedrock
registerProvider({
  name: 'bedrock',
  priority: 30,
  detect: async () => {
    const flag = process.env.CLAUDE_CODE_USE_BEDROCK;
    return flag === '1' || flag === 'true';
  },
  env: async () => {
    const result = { CLAUDE_CODE_USE_BEDROCK: '1' };
    for (const key of [
      'AWS_REGION', 'AWS_DEFAULT_REGION',
      'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
      'AWS_PROFILE', 'AWS_ROLE_ARN',
      'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
    ]) {
      if (process.env[key]) result[key] = process.env[key];
    }
    return result;
  },
});

// 4. Google Vertex
registerProvider({
  name: 'vertex',
  priority: 40,
  detect: async () => {
    const flag = process.env.CLAUDE_CODE_USE_VERTEX;
    return flag === '1' || flag === 'true';
  },
  env: async () => {
    const result = { CLAUDE_CODE_USE_VERTEX: '1' };
    for (const key of [
      'GOOGLE_CLOUD_PROJECT', 'CLOUD_ML_REGION',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
    ]) {
      if (process.env[key]) result[key] = process.env[key];
    }
    return result;
  },
});

// ============ Public API ============

/**
 * Discover available Claude credentials.
 * Tries providers in priority order, returns the first match.
 *
 * @returns {Promise<{provider: string, env: Record<string, string>}>}
 */
export async function discoverCredentials() {
  for (const provider of providers) {
    try {
      if (await provider.detect()) {
        return {
          provider: provider.name,
          env: await provider.env(),
        };
      }
    } catch (err) {
      console.warn(`[credentials] Provider ${provider.name} failed:`, err.message);
    }
  }

  return { provider: 'none', env: {} };
}

/**
 * Build the full environment for a spawned Claude process.
 * Merges discovered credentials with base env vars.
 *
 * Works identically across Docker, Kubernetes, and any future
 * container runtime — only reads env vars and filesystem.
 *
 * @param {Record<string, string>} [extraEnv] - Additional env vars to include
 * @returns {Promise<Record<string, string>>}
 */
export async function buildClaudeEnv(extraEnv = {}) {
  const { provider, env: credEnv } = await discoverCredentials();

  console.log(`[credentials] Using provider: ${provider}`);

  return {
    ...process.env,
    ...credEnv,
    ...extraEnv,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    GH_TOKEN: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
  };
}

/**
 * Health check: returns which credential provider is available
 * and the status of all registered providers.
 */
export async function credentialStatus() {
  const { provider: active } = await discoverCredentials();

  const providerStatuses = [];
  for (const p of providers) {
    try {
      providerStatuses.push({
        name: p.name,
        priority: p.priority,
        available: await p.detect(),
      });
    } catch {
      providerStatuses.push({
        name: p.name,
        priority: p.priority,
        available: false,
      });
    }
  }

  return {
    activeProvider: active,
    providers: providerStatuses,
  };
}
