import { LocalDispatcher } from './local.js';
import { KubernetesDispatcher } from './kubernetes.js';

/**
 * @typedef {Object} SpawnOptions
 * @property {string} cwd - Working directory for the process
 * @property {Object} env - Environment variables
 * @property {number} [cols=200] - Terminal columns
 * @property {number} [rows=50] - Terminal rows
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
 * @param {'local'|'kubernetes'} [mode] - Override for dispatch mode
 * @returns {LocalDispatcher|KubernetesDispatcher}
 */
export function createDispatcher(mode) {
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

    default:
      throw new Error(`Unknown DISPATCH_MODE: ${dispatchMode}. Must be "local" or "kubernetes".`);
  }
}

export { LocalDispatcher, KubernetesDispatcher };
