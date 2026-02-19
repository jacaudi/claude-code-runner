import * as k8s from '@kubernetes/client-node';
import { PassThrough } from 'stream';

/**
 * Dispatches Claude processes as Kubernetes Jobs.
 *
 * Each spawn() call creates a K8s Job with a single-container Pod.
 * Log streaming is handled via the K8s log API, and process termination
 * is implemented by deleting the Job.
 */
export class KubernetesDispatcher {
  /**
   * @param {Object} config
   * @param {string} config.namespace - K8s namespace for Jobs
   * @param {string} config.image - Container image to run
   * @param {string} [config.serviceAccount] - Service account for Pods
   * @param {string} [config.resourceLimitsCpu] - CPU limit
   * @param {string} [config.resourceLimitsMemory] - Memory limit
   * @param {string} [config.resourceRequestsCpu] - CPU request
   * @param {string} [config.resourceRequestsMemory] - Memory request
   * @param {string} [config.credentialsSecret] - Secret name for Claude credentials
   * @param {string} [config.githubTokenSecret] - Secret name for GitHub token
   */
  constructor(config) {
    this.config = config;

    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();

    this.batchApi = kc.makeApiClient(k8s.BatchV1Api);
    this.coreApi = kc.makeApiClient(k8s.CoreV1Api);
    this.log = new k8s.Log(kc);
  }

  /**
   * Spawn a process as a Kubernetes Job.
   *
   * @param {string} command - The command to run inside the container
   * @param {string[]} args - Command arguments
   * @param {import('./index.js').SpawnOptions} options
   * @returns {import('./index.js').ProcessHandle}
   */
  spawn(command, args, options) {
    const jobName = `claude-task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const namespace = this.config.namespace;

    let dataCallback = null;
    let exitCallback = null;
    let killed = false;

    const envVars = Object.entries(options.env || {})
      .filter(([key]) => !key.startsWith('npm_') && key !== 'PATH')
      .map(([name, value]) => ({ name, value: String(value) }));

    const jobSpec = this._buildJobSpec(jobName, command, args, envVars, options.cwd);

    // Launch the Job asynchronously and wire up log streaming + completion watching
    const jobPromise = this._createAndWatch(jobName, namespace, jobSpec, {
      onData: (data) => dataCallback?.(data),
      onExit: (exitCode) => exitCallback?.({ exitCode }),
      isKilled: () => killed,
    });

    // Surface any unhandled errors from the background job lifecycle
    jobPromise.catch((err) => {
      console.error(`[k8s] Job ${jobName} error:`, err.message);
      exitCallback?.({ exitCode: 1 });
    });

    return {
      pid: jobName,
      onData: (cb) => { dataCallback = cb; },
      onExit: (cb) => { exitCallback = cb; },
      write: () => {}, // K8s jobs don't support stdin; no-op for interface compat
      resize: () => {}, // K8s jobs don't support resize; no-op for interface compat
      kill: () => {
        killed = true;
        this._deleteJob(jobName, namespace).catch((err) => {
          console.error(`[k8s] Failed to delete job ${jobName}:`, err.message);
        });
      },
    };
  }

  /**
   * Build the Job manifest.
   */
  _buildJobSpec(jobName, command, args, envVars, cwd) {
    const container = {
      name: 'claude-worker',
      image: this.config.image,
      command: [command],
      args,
      env: envVars,
      workingDir: cwd || '/tmp/work',
      resources: {
        requests: {
          cpu: this.config.resourceRequestsCpu || '500m',
          memory: this.config.resourceRequestsMemory || '1Gi',
        },
        limits: {
          cpu: this.config.resourceLimitsCpu || '2',
          memory: this.config.resourceLimitsMemory || '4Gi',
        },
      },
      volumeMounts: [
        {
          name: 'claude-credentials',
          mountPath: '/home/node/.claude/.credentials.json',
          subPath: '.credentials.json',
          readOnly: true,
        },
        {
          name: 'work',
          mountPath: '/tmp/work',
        },
      ],
    };

    const volumes = [
      {
        name: 'claude-credentials',
        secret: {
          secretName: this.config.credentialsSecret,
        },
      },
      {
        name: 'work',
        emptyDir: {},
      },
    ];

    // Inject GitHub token from secret as env var if configured
    if (this.config.githubTokenSecret) {
      container.env.push({
        name: 'GITHUB_TOKEN',
        valueFrom: {
          secretKeyRef: {
            name: this.config.githubTokenSecret,
            key: 'token',
          },
        },
      });
      container.env.push({
        name: 'GH_TOKEN',
        valueFrom: {
          secretKeyRef: {
            name: this.config.githubTokenSecret,
            key: 'token',
          },
        },
      });
    }

    const spec = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: jobName,
        namespace: this.config.namespace,
        labels: {
          app: 'claude-code-runner',
          component: 'task',
        },
      },
      spec: {
        backoffLimit: 0,
        ttlSecondsAfterFinished: 3600,
        template: {
          metadata: {
            labels: {
              app: 'claude-code-runner',
              job: jobName,
            },
          },
          spec: {
            restartPolicy: 'Never',
            containers: [container],
            volumes,
            ...(this.config.serviceAccount
              ? { serviceAccountName: this.config.serviceAccount }
              : {}),
          },
        },
      },
    };

    return spec;
  }

  /**
   * Create the Job, wait for a Pod, stream logs, and watch for completion.
   */
  async _createAndWatch(jobName, namespace, jobSpec, callbacks) {
    // Create the Job
    await this.batchApi.createNamespacedJob({ namespace, body: jobSpec });
    console.log(`[k8s] Job ${jobName} created in namespace ${namespace}`);

    // Wait for a Pod to appear
    const podName = await this._waitForPod(jobName, namespace);
    if (callbacks.isKilled()) return;

    console.log(`[k8s] Pod ${podName} started for job ${jobName}`);

    // Stream logs
    this._streamLogs(podName, namespace, callbacks).catch((err) => {
      console.error(`[k8s] Log streaming error for ${podName}:`, err.message);
    });

    // Watch for Job completion
    await this._waitForCompletion(jobName, namespace, callbacks);
  }

  /**
   * Poll until a Pod exists for the given Job.
   */
  async _waitForPod(jobName, namespace, timeoutMs = 300000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const { items } = await this.coreApi.listNamespacedPod({
        namespace,
        labelSelector: `job=${jobName}`,
      });

      if (items.length > 0) {
        const pod = items[0];
        const phase = pod.status?.phase;
        if (phase === 'Running' || phase === 'Succeeded' || phase === 'Failed') {
          return pod.metadata.name;
        }
      }

      await new Promise((r) => setTimeout(r, 2000));
    }

    throw new Error(`Timed out waiting for pod for job ${jobName}`);
  }

  /**
   * Stream logs from a Pod's container.
   */
  async _streamLogs(podName, namespace, callbacks) {
    const logStream = new PassThrough();

    logStream.on('data', (chunk) => {
      callbacks.onData(chunk.toString());
    });

    await this.log.log(namespace, podName, 'claude-worker', logStream, {
      follow: true,
      pretty: false,
    });
  }

  /**
   * Poll the Job status until it completes or fails.
   */
  async _waitForCompletion(jobName, namespace, callbacks) {
    while (!callbacks.isKilled()) {
      const job = await this.batchApi.readNamespacedJob({ name: jobName, namespace });
      const status = job.status;

      if (status?.succeeded >= 1) {
        callbacks.onExit(0);
        return;
      }

      if (status?.failed >= 1) {
        callbacks.onExit(1);
        return;
      }

      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  /**
   * Delete a Job and its Pods.
   */
  async _deleteJob(jobName, namespace) {
    await this.batchApi.deleteNamespacedJob({
      name: jobName,
      namespace,
      body: { propagationPolicy: 'Foreground' },
    });
    console.log(`[k8s] Job ${jobName} deleted`);
  }
}
