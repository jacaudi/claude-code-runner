import k8s from '@kubernetes/client-node';

let batchApi = null;
let coreApi = null;
let namespace = 'default';
let workerImage = 'ericvtheg/claude-code-runner:latest';
let controllerService = 'claude-controller';

export function initK8s() {
  // Check if we should use K8s (in-cluster or explicit config)
  if (!process.env.KUBERNETES_SERVICE_HOST && !process.env.KUBECONFIG) {
    console.log('Not running in Kubernetes, using local mode');
    return false;
  }

  const kc = new k8s.KubeConfig();

  if (process.env.KUBERNETES_SERVICE_HOST) {
    kc.loadFromCluster();
  } else {
    kc.loadFromDefault();
  }

  batchApi = kc.makeApiClient(k8s.BatchV1Api);
  coreApi = kc.makeApiClient(k8s.CoreV1Api);

  namespace = process.env.NAMESPACE || 'default';
  workerImage = process.env.WORKER_IMAGE || workerImage;
  controllerService = process.env.CONTROLLER_SERVICE || controllerService;

  return true;
}

export function isK8sEnabled() {
  return batchApi !== null;
}

export async function createWorkerJob(taskId, prompt) {
  if (!batchApi) throw new Error('Kubernetes not initialized');

  const jobName = `claude-worker-${taskId}`;
  const branchName = `claude/${taskId}`;

  const job = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace: namespace,
      labels: {
        app: 'claude-worker',
        'task-id': taskId
      }
    },
    spec: {
      ttlSecondsAfterFinished: 3600,
      backoffLimit: 0,
      template: {
        metadata: {
          labels: {
            app: 'claude-worker',
            'task-id': taskId
          }
        },
        spec: {
          restartPolicy: 'Never',
          containers: [{
            name: 'worker',
            image: workerImage,
            command: ['node', 'src/worker.js'],
            env: [
              { name: 'TASK_ID', value: taskId },
              { name: 'TASK_PROMPT', value: prompt },
              { name: 'BRANCH_NAME', value: branchName },
              { name: 'CONTROLLER_URL', value: `http://${controllerService}.${namespace}.svc.cluster.local` },
              {
                name: 'GITHUB_TOKEN',
                valueFrom: { secretKeyRef: { name: 'github-token', key: 'token' } }
              }
            ],
            volumeMounts: [{
              name: 'claude-credentials',
              mountPath: '/home/node/.claude',
              readOnly: true
            }],
            resources: {
              requests: { memory: '512Mi', cpu: '250m' },
              limits: { memory: '4Gi', cpu: '2' }
            }
          }],
          volumes: [{
            name: 'claude-credentials',
            secret: { secretName: 'claude-credentials' }
          }]
        }
      }
    }
  };

  const response = await batchApi.createNamespacedJob(namespace, job);
  return response.body;
}

export async function getJobStatus(taskId) {
  if (!batchApi) throw new Error('Kubernetes not initialized');

  const jobName = `claude-worker-${taskId}`;
  try {
    const response = await batchApi.readNamespacedJob(jobName, namespace);
    return response.body.status;
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

export async function getPodLogs(taskId) {
  if (!coreApi) throw new Error('Kubernetes not initialized');

  const labelSelector = `task-id=${taskId}`;

  const pods = await coreApi.listNamespacedPod(
    namespace,
    undefined, undefined, undefined, undefined,
    labelSelector
  );

  if (pods.body.items.length === 0) {
    return null;
  }

  const podName = pods.body.items[0].metadata.name;

  try {
    const response = await coreApi.readNamespacedPodLog(
      podName,
      namespace,
      'worker'
    );
    return response.body;
  } catch (err) {
    if (err.statusCode === 400) {
      return '(container not ready yet)';
    }
    throw err;
  }
}

export async function deleteJob(taskId) {
  if (!batchApi) throw new Error('Kubernetes not initialized');

  const jobName = `claude-worker-${taskId}`;
  await batchApi.deleteNamespacedJob(
    jobName,
    namespace,
    undefined,
    undefined,
    undefined,
    undefined,
    'Background'
  );
}

export function getNamespace() {
  return namespace;
}
