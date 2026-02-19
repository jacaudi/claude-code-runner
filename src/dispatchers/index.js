import { LocalDispatcher } from './local.js';
import { KubernetesDispatcher } from './kubernetes.js';
import { RedisDispatcher } from './redis-worker.js';

/**
 * @typedef {Object} SpawnOptions
 * @property {string} cwd - Working directory for the process
 * @property {Object} env - Environment variables
 * @property {number} [cols=200] - Terminal columns
 * @property {number} [rows=50] - Terminal rows
 * @property {string} [taskId] - Task ID (required for redis mode)
 * @property {string} [phase] - Task phase (orchestrator/worker, used by redis mode)
 * @property {string} [prompt] - Task prompt (used by redis mode)
 */

/**
 * @typedef {Object} ProcessHandle
 * @property {number|string} pid - Process or pod identifier
 * @property {function(function(string): void): void} onData - Register data callback
 * @property {function(function({exitCode: number}): void): void} onExit - Register exit callback
 * @property {function(): void} kill - Terminate the process
 */

/**
 * Creates the appropriate dispatcher based on DISPATCH_MODE environment variable.
 *
 * Modes:
 * - "local" (default): Runs Claude processes directly via node-pty
 * - "kubernetes": Creates K8s Jobs via the K8s API (requires K8s API access)
 * - "redis": Enqueues tasks to Redis for worker pods to pick up (no K8s API needed)
 *
 * @param {'local'|'kubernetes'|'redis'} [mode] - Override for dispatch mode
 * @param {Object} [deps] - External dependencies
 * @param {import('../queue/redis.js').RedisQueue} [deps.redisQueue] - Redis queue (required for redis mode)
 * @returns {LocalDispatcher|KubernetesDispatcher|RedisDispatcher}
 */
export function createDispatcher(mode, deps = {}) {
  const dispatchMode = mode || process.env.DISPATCH_MODE || 'local';

  switch (dispatchMode) {
    case 'local':
      return new LocalDispatcher();

    case 'kubernetes':
      return new KubernetesDispatcher({
        namespace: process.env.K8S_NAMESPACE || 'default',
        image: process.env.K8S_IMAGE || 'ericvtheg/claude-code-runner',
        serviceAccount: process.env.K8S_SERVICE_ACCOUNT || '',
        resourceLimitsCpu: process.env.K8S_CPU_LIMIT || '2',
        resourceLimitsMemory: process.env.K8S_MEMORY_LIMIT || '4Gi',
        resourceRequestsCpu: process.env.K8S_CPU_REQUEST || '500m',
        resourceRequestsMemory: process.env.K8S_MEMORY_REQUEST || '1Gi',
        credentialsSecret: process.env.K8S_CREDENTIALS_SECRET || 'claude-credentials',
        githubTokenSecret: process.env.K8S_GITHUB_TOKEN_SECRET || 'github-token',
      });

    case 'redis':
      if (!deps.redisQueue) {
        throw new Error('Redis dispatch mode requires a RedisQueue instance (pass via deps.redisQueue)');
      }
      return new RedisDispatcher(deps.redisQueue);

    default:
      throw new Error(`Unknown DISPATCH_MODE: ${dispatchMode}. Must be "local", "kubernetes", or "redis".`);
  }
}

export { LocalDispatcher, KubernetesDispatcher, RedisDispatcher };
