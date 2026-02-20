/**
 * Standalone worker entrypoint for Redis-based task execution.
 *
 * Run this in worker pods/containers. It connects to Redis, pulls tasks
 * from the queue, and executes them using the local dispatcher (node-pty).
 *
 * Usage:
 *   REDIS_URL=redis://redis:6379 node src/worker.js
 *
 * Environment:
 *   REDIS_URL       - Redis connection URL (required)
 *   GITHUB_TOKEN    - GitHub token for Claude (required)
 *   WORKER_ID       - Identifier for this worker (optional, auto-generated)
 */

import { RedisQueue } from './queue/redis.js';
import { RedisWorkerExecutor } from './dispatchers/redis-worker.js';
import { randomUUID } from 'crypto';

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.error('REDIS_URL environment variable is required');
  process.exit(1);
}

const WORKER_ID = process.env.WORKER_ID || `worker-${randomUUID().slice(0, 8)}`;

console.log(`[${WORKER_ID}] Starting worker...`);
console.log(`[${WORKER_ID}] Redis: ${REDIS_URL.replace(/\/\/.*@/, '//***@')}`);

const queue = new RedisQueue(REDIS_URL);
const executor = new RedisWorkerExecutor(queue);

// Graceful shutdown
async function shutdown(signal) {
  console.log(`[${WORKER_ID}] Received ${signal}, shutting down...`);
  executor.stop();

  // Give current task a moment to finish
  await new Promise((r) => setTimeout(r, 2000));
  await queue.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Health check: verify Redis connectivity
try {
  const ok = await queue.ping();
  if (!ok) throw new Error('Redis ping failed');
  console.log(`[${WORKER_ID}] Redis connected`);
} catch (err) {
  console.error(`[${WORKER_ID}] Cannot connect to Redis:`, err.message);
  process.exit(1);
}

// Start processing tasks
executor.start().catch((err) => {
  console.error(`[${WORKER_ID}] Fatal error:`, err);
  process.exit(1);
});
