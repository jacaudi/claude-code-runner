# Architecture Plan: Controller/Runner Split via gRPC

## Overview

Split the monolithic `src/server.js` into two components:

- **Controller** — User-facing Express server. Owns the HTTP API, dashboard UI, authentication, task state, and **Runner lifecycle management**. Uses the Docker socket to create, monitor, and destroy Runner containers on demand.
- **Runner** — Headless container that executes Claude tasks. Exposes a gRPC `RunnerService` on a Unix domain socket. Has no HTTP API. Knows nothing about the Controller — it just serves RPCs.

The Controller manages a **pool of Runners**. Runners come in two flavors:

| Type | Lifecycle | Use Case |
|------|-----------|----------|
| **Persistent** | Created via API, stays alive indefinitely. Restarted by Controller if it dies. | Steady workload, always-ready capacity. |
| **Ephemeral** | Created on-demand for a task (or batch of related tasks). Auto-removed after idle timeout. | Burst capacity, isolation per job. |

Communication: gRPC over per-runner Unix domain sockets in a shared bind-mount directory.

## Architecture Diagram

```
                        ┌─────────────────────────────────────────────────┐
   HTTP :3000           │                 CONTROLLER                      │
   ─────────────────────│                                                 │
   POST /task           │  Express server         Runner Pool Manager     │
   GET  /task/:id       │  Auth (session+bearer)  ┌─────────────────┐    │
   GET  /tasks          │  Dashboard UI           │ dockerode        │    │
   GET  /health         │  Task state (Map)       │ create/stop/rm   │    │
                        │  Log buffers            │ health monitor   │    │
   POST /runners        │  Task router            │ idle reaper      │    │
   GET  /runners        │                         └────────┬────────┘    │
   DELETE /runners/:id  │                                  │ Docker API   │
                        └──────────┬───────────────────────┼─────────────┘
                                   │                       │
                          gRPC over UDS                    │ /var/run/docker.sock
                          /var/run/claude-runners/         │
                          runner-{id}.sock                 │
                                   │                       │
              ┌────────────────────┼───────────────────────┼──────────┐
              │                    │                       ▼          │
              │    ┌───────────────┴──────────────┐   Docker Engine   │
              │    │         RUNNER (container)    │                  │
              │    │                               │                  │
              │    │  gRPC server (RunnerService)  │    ┌──────────┐ │
              │    │  Task executor (node-pty)     │    │ Runner 2 │ │
              │    │  Orchestrator + Worker phases │    └──────────┘ │
              │    │  System prompts              │    ┌──────────┐ │
              │    │                               │    │ Runner N │ │
              │    └───────────────────────────────┘    └──────────┘ │
              │                                                      │
              │                     Docker Host                      │
              └──────────────────────────────────────────────────────┘
```

## Communication: Unix Sockets via Shared Bind Mount

**Why not tmpfs?** Docker tmpfs mounts are per-container and cannot be shared. We use a **bind-mounted host directory** instead.

```
Host directory:  /var/run/claude-runners/   (bind-mounted into Controller + all Runners)
                 ├── runner-abc123.sock
                 ├── runner-def456.sock
                 └── runner-ghi789.sock
```

- Controller creates this directory on startup
- Each Runner container gets the directory bind-mounted at the same path
- Each Runner listens on `unix:///var/run/claude-runners/runner-{id}.sock`
- Controller connects to each Runner at its known socket path
- **Gotcha**: Must set `grpc.default_authority: 'localhost'` on all gRPC client connections over UDS

## Proto Definition

See `proto/runner.proto`. Four RPCs on `RunnerService`:

| RPC | Type | Purpose |
|-----|------|---------|
| `ExecuteTask` | Server-streaming | Full task lifecycle — logs, status changes, and final result as `TaskEvent` stream |
| `CancelTask` | Unary | Kill a running task via `AbortController` |
| `HealthCheck` | Unary | Verify Runner is alive, get running/max task counts, runner ID |
| `Drain` | Unary | Stop accepting new tasks, finish current ones. Used before teardown. |

The proto only defines the Runner-side service. Runner management (create, destroy, list) is internal to the Controller and exposed via HTTP API — no proto needed for that.

## Directory Structure

```
claude-code-runner/
├── proto/
│   └── runner.proto                     # gRPC service definition
├── src/
│   ├── controller/
│   │   ├── server.js                    # Express app, auth, routes, startup
│   │   ├── runner-pool.js               # Runner lifecycle: create, destroy, health, reap
│   │   ├── task-router.js               # Decide which Runner gets a task
│   │   └── static/
│   │       ├── dashboard.html
│   │       ├── login.html
│   │       └── setup.html
│   ├── runner/
│   │   ├── server.js                    # gRPC server, task management
│   │   ├── executor.js                  # Orchestrator + Worker phase execution
│   │   └── prompts.js                   # System prompt generators
│   └── shared/
│       ├── grpc-client.js               # gRPC client factory with UDS + keepalive config
│       └── proto-loader.js              # Loads runner.proto
├── Dockerfile.controller                # Lightweight: Node.js + curl + dockerode
├── Dockerfile.runner                    # Full: Node.js + gh CLI + Claude Code + build tools
├── docker-compose.yml                   # Controller + optional default persistent runner
└── package.json
```

### New file: `src/controller/runner-pool.js`

Manages the full Runner container lifecycle via `dockerode`:

```javascript
// src/controller/runner-pool.js
//
// Runner registry entry shape:
// {
//   id: string,                  // e.g. "abc123"
//   type: 'persistent' | 'ephemeral',
//   containerId: string,         // Docker container ID
//   socketPath: string,          // /var/run/claude-runners/runner-abc123.sock
//   grpcClient: RunnerService,   // gRPC client instance
//   status: 'starting' | 'ready' | 'draining' | 'dead',
//   runningTasks: number,
//   maxConcurrentTasks: number,
//   createdAt: Date,
//   lastTaskAt: Date | null,     // For ephemeral idle reaping
// }

export class RunnerPool {
  constructor(docker, options) {
    this.docker = docker;            // dockerode instance
    this.runners = new Map();        // id -> runner entry
    this.socketDir = options.socketDir || '/var/run/claude-runners';
    this.runnerImage = options.runnerImage || 'claude-code-runner-runner:latest';
    this.ephemeralIdleTimeout = options.ephemeralIdleTimeout || 10 * 60 * 1000; // 10 min
    this.defaultMaxTasks = options.defaultMaxTasks || 1;
    this.healthInterval = null;
    this.reapInterval = null;
  }

  async start() { /* start health checker + idle reaper intervals */ }
  async stop() { /* drain all, stop intervals, cleanup */ }

  async createRunner(type, options) { /* create container, wait for ready, add to pool */ }
  async destroyRunner(id) { /* drain, stop, remove container */ }
  async getRunner(id) { /* return runner entry */ }
  listRunners() { /* return all runner entries */ }

  // Internal
  async _startContainer(runnerId, type) { /* dockerode create + start */ }
  async _waitForReady(runnerId, timeoutMs) { /* poll HealthCheck until ok */ }
  async _healthCheck() { /* periodic: check all runners, mark dead ones */ }
  async _reapIdle() { /* periodic: destroy idle ephemeral runners */ }

  // Task routing helpers
  getAvailableRunner() { /* find a ready runner with capacity */ }
  async getOrCreateRunner(type) { /* get available or spin up new one */ }
}
```

### New file: `src/controller/task-router.js`

Decides which Runner handles a task:

```javascript
// src/controller/task-router.js

export class TaskRouter {
  constructor(runnerPool) {
    this.pool = runnerPool;
  }

  // Route a task to a runner. Creates ephemeral runner if no capacity.
  async route(taskId, options) {
    // 1. If options.runnerId specified, use that runner
    // 2. Try to find a ready persistent runner with capacity
    // 3. Try to find a ready ephemeral runner with capacity
    // 4. Create a new ephemeral runner
    // Returns: { runner, grpcClient }
  }
}
```

## Runner Container Creation

When Controller creates a Runner container via dockerode:

```javascript
const container = await docker.createContainer({
  Image: 'claude-code-runner-runner:latest',
  name: `claude-runner-${runnerId}`,
  Env: [
    `RUNNER_ID=${runnerId}`,
    `RUNNER_SOCKET=/var/run/claude-runners/runner-${runnerId}.sock`,
    `RUNNER_MAX_TASKS=${maxConcurrentTasks}`,
  ],
  HostConfig: {
    Binds: [
      // Shared socket directory (bind mount, NOT tmpfs)
      `${socketDir}:/var/run/claude-runners:rw`,
      // Claude credentials (read-only)
      `${credentialsPath}:/home/node/.claude/.credentials.json:ro`,
    ],
    // Resource limits
    Memory: 4 * 1024 * 1024 * 1024,  // 4GB
    CpuShares: 2048,
  },
  // Connect to our bridge network for potential future TCP fallback
  NetworkingConfig: {
    EndpointsConfig: {
      'claude-runner-net': {
        Aliases: [`runner-${runnerId}`]
      }
    }
  }
});

await container.start();
```

The Runner container's entrypoint (`node src/runner/server.js`) reads `RUNNER_SOCKET` and starts a gRPC server on that path.

## Runner Types: Persistent vs Ephemeral

### Persistent Runners

- Created explicitly via `POST /runners` with `type: 'persistent'`
- Or defined in config/docker-compose for always-on capacity
- Controller restarts them if they die (health check detects, recreates)
- Accept tasks continuously until drained
- Use case: steady background workload, guaranteed capacity

### Ephemeral Runners

- Created automatically when a task arrives and no runner has capacity
- Or created explicitly via `POST /runners` with `type: 'ephemeral'`
- Torn down automatically after `EPHEMERAL_IDLE_TIMEOUT` (default 10min) with no running tasks
- Can also be torn down explicitly via `DELETE /runners/:id`
- Use case: burst traffic, job isolation, resource reclamation

### Lifecycle State Machine

```
  ┌──────────┐    container started    ┌─────────┐
  │ starting ├────────────────────────►│  ready   │
  └──────────┘    HealthCheck ok       └────┬─────┘
                                            │
                               Drain()      │  health check fails
                                 │          │
                                 ▼          ▼
                           ┌──────────┐  ┌──────┐
                           │ draining │  │ dead │
                           └────┬─────┘  └──┬───┘
                                │            │
                    all tasks   │            │  (persistent: recreate)
                    finished    │            │  (ephemeral: remove)
                                ▼            ▼
                           ┌─────────────────────┐
                           │  container removed   │
                           └─────────────────────┘
```

## HTTP API: Runner Management

New endpoints on the Controller:

### `POST /runners` — Create a runner

```json
// Request
{
  "type": "persistent",         // or "ephemeral"
  "maxConcurrentTasks": 2       // optional, default 1
}

// Response
{
  "id": "abc123",
  "type": "persistent",
  "status": "starting",
  "socketPath": "/var/run/claude-runners/runner-abc123.sock",
  "maxConcurrentTasks": 2,
  "createdAt": "2026-02-10T12:00:00Z"
}
```

### `GET /runners` — List all runners

```json
[
  {
    "id": "abc123",
    "type": "persistent",
    "status": "ready",
    "containerId": "sha256:...",
    "runningTasks": 1,
    "maxConcurrentTasks": 2,
    "createdAt": "2026-02-10T12:00:00Z",
    "lastTaskAt": "2026-02-10T14:30:00Z"
  }
]
```

### `GET /runners/:id` — Runner details

Returns the same shape as a list entry, plus recent task IDs.

### `DELETE /runners/:id` — Destroy a runner

Drains the runner (waits for in-flight tasks), then stops and removes the container. Query param `?force=true` kills immediately.

```json
// Response
{ "id": "abc123", "status": "draining", "remainingTasks": 1 }
```

### `POST /task` — Updated

Optionally accepts `runnerId` to target a specific runner. Otherwise auto-routes.

```json
// Request
{
  "prompt": "Add dark mode to the dashboard",
  "runnerId": "abc123"   // optional: pin to specific runner
}
```

## Task Lifecycle Flow (Multi-Runner)

```
User ──POST /task──► Controller
                       │
                       ├─ Create task in Map {status:'queued'}
                       ├─ Return {id, status:'queued'} immediately
                       │
                       ▼
                   TaskRouter.route(taskId)
                       │
                       ├─ runnerId specified? → use that runner
                       ├─ persistent runner with capacity? → use it
                       ├─ ephemeral runner with capacity? → use it
                       └─ no capacity → RunnerPool.createRunner('ephemeral')
                                          │
                                          ├─ docker.createContainer(...)
                                          ├─ container.start()
                                          ├─ poll HealthCheck until ready
                                          └─ return new runner
                       │
                       ▼
                   runner.grpcClient.ExecuteTask(request)
                       │
                  gRPC stream (unix:///var/run/claude-runners/runner-{id}.sock)
                       │
                       ▼
                   Runner container
                     │
                     ├─ emit STATUS_CHANGE(running, orchestrator)
                     ├─ spawn claude CLI (orchestrator, 20min timeout)
                     ├─ emit LOG lines
                     ├─ emit STATUS_CHANGE(running, worker)
                     ├─ spawn claude CLI (worker, 1hr timeout)
                     ├─ emit LOG lines
                     └─ emit RESULT(success, pr_url, ...)
                       │
                  stream closes
                       │
                       ▼
                   Controller
                     │
                     ├─ Updates task in Map (status, pr_url, error, logs)
                     ├─ Updates runner.runningTasks--
                     └─ Updates runner.lastTaskAt = now
                              │
                              └─ (ephemeral idle reaper checks later:
                                  if no tasks for 10min → drain & destroy)
```

## Log Streaming

Unchanged from original plan:
- **Runner**: Each `proc.onData(data)` chunk from `node-pty` → `TaskEvent{type:LOG}` on gRPC stream
- **Controller**: Accumulates in `task.logLines[]` per task
- **Dashboard**: Fetches `/task/:id/logs` → `logLines.join('\n')` — no changes to `dashboard.html`

## Error Handling

| Scenario | Propagation |
|----------|-------------|
| Orchestrator/Worker timeout | Runner emits `RESULT{error_type:'timeout'}` |
| Non-zero exit code | Runner emits `RESULT{error_type:'exit_code'}` |
| Runner container dies mid-task | gRPC stream error → Controller marks task `failed` with `errorType:'runner_died'`. Persistent runner gets recreated. |
| Socket vanishes | Same as container death |
| Task cancellation | Controller calls `CancelTask` RPC → Runner aborts → `RESULT{error_type:'cancelled'}` |
| No runners available + Docker create fails | Task immediately fails with `errorType:'no_runner'` |
| Runner at capacity | TaskRouter skips it, tries next runner or creates ephemeral |

## Health Monitoring

The Controller runs two periodic loops:

### 1. Health Checker (every 15s)

```javascript
for (const runner of this.runners.values()) {
  try {
    const resp = await runner.grpcClient.HealthCheck({}, { deadline: Date.now() + 5000 });
    runner.runningTasks = resp.running_tasks;
    runner.status = 'ready';
  } catch {
    runner.status = 'dead';
    if (runner.type === 'persistent') {
      // Recreate: stop old container, create new one with same config
      await this._recreateRunner(runner);
    } else {
      // Ephemeral: just clean up
      await this._removeContainer(runner.containerId);
      this.runners.delete(runner.id);
    }
  }
}
```

### 2. Idle Reaper (every 60s)

```javascript
const now = Date.now();
for (const runner of this.runners.values()) {
  if (runner.type !== 'ephemeral') continue;
  if (runner.runningTasks > 0) continue;
  const idle = now - (runner.lastTaskAt?.getTime() || runner.createdAt.getTime());
  if (idle > this.ephemeralIdleTimeout) {
    await this.destroyRunner(runner.id);
  }
}
```

## Controller `/health` endpoint

```json
{
  "ok": true,
  "tasks": 5,
  "running": 2,
  "runners": {
    "total": 3,
    "ready": 2,
    "starting": 1,
    "dead": 0,
    "persistent": 1,
    "ephemeral": 2
  }
}
```

## Docker Setup

### docker-compose.yml

```yaml
services:
  controller:
    build:
      context: .
      dockerfile: Dockerfile.controller
    container_name: claude-controller
    ports:
      - "7334:3000"
    environment:
      - GITHUB_TOKEN=${GITHUB_TOKEN}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
      - PORT=3000
      - SOCKET_DIR=/var/run/claude-runners
      - RUNNER_IMAGE=claude-code-runner-runner:latest
      - EPHEMERAL_IDLE_TIMEOUT=600000
      - CREDENTIALS_PATH=${HOME}/.claude/.credentials.json
    volumes:
      - claude-data:/data
      # Docker socket — Controller creates Runner containers
      - /var/run/docker.sock:/var/run/docker.sock
      # Shared socket directory — bind mount on host
      - claude-sockets:/var/run/claude-runners
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s

volumes:
  claude-data:
  claude-sockets:
```

Note: No `runner` service in compose. The Controller creates Runner containers dynamically via Docker API. You _can_ define a default persistent runner in compose for convenience, but it's optional.

### Dockerfile.controller

```dockerfile
FROM node:20-slim

RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install
COPY proto ./proto
COPY src/shared ./src/shared
COPY src/controller ./src/controller

RUN chown -R node:node /app
RUN mkdir -p /data && chown -R node:node /data
RUN mkdir -p /var/run/claude-runners && chown -R node:node /var/run/claude-runners

USER node

EXPOSE 3000
CMD ["node", "src/controller/server.js"]
```

### Dockerfile.runner

```dockerfile
FROM node:20-slim

RUN apt-get update && apt-get install -y \
    git curl ssh python3 make g++ jq \
    && rm -rf /var/lib/apt/lists/*

# gh CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh

# Claude Code
RUN npm install -g @anthropic-ai/claude-code

RUN mkdir -p /home/node/.claude && chown -R node:node /home/node

WORKDIR /app
COPY package.json ./
RUN npm install
COPY proto ./proto
COPY src/shared ./src/shared
COPY src/runner ./src/runner

RUN chown -R node:node /app
RUN mkdir -p /tmp/work && chown -R node:node /tmp/work
RUN chown -R node:node /usr/local /opt

ENV PATH=/home/node/.local/bin:/home/node/.cargo/bin:/home/node/go/bin:/home/node/.bun/bin:$PATH

USER node

RUN git config --global user.email "noreply@anthropic.com" \
    && git config --global user.name "Claude"

# No EXPOSE — communication is via Unix socket only
CMD ["node", "src/runner/server.js"]
```

## New Dependencies

```json
{
  "@grpc/grpc-js": "^1.10.0",
  "@grpc/proto-loader": "^0.7.12",
  "dockerode": "^4.0.0"
}
```

- `@grpc/grpc-js` + `@grpc/proto-loader` — gRPC on both Controller (client) and Runner (server)
- `dockerode` — Controller only, for Docker container management
- `node-pty` — Runner only (already in package.json)
- `express`, `express-session`, `bcryptjs` — Controller only (already in package.json)

## What Moves Where (from current server.js)

### Controller keeps

| Current server.js lines | What | Changes? |
|--------------------------|------|----------|
| 1-29 | Express setup, session config | No |
| 31-131 | Auth, requireAuth middleware | No |
| 136-138 | `tasks` Map, constants | Remove `WORK_DIR`; add runner pool init |
| 140-272 | Auth routes (setup, login, logout, token CRUD) | No |
| 338-367 | `POST /task` | Delegates to TaskRouter instead of `runTask()` |
| 370-406 | `GET /task/:id`, logs, health, tasks list, dashboard | Logs from memory; health includes runner stats |

### Controller gains (new)

- `POST/GET/DELETE /runners` endpoints
- `RunnerPool` class (Docker lifecycle management)
- `TaskRouter` class (runner selection logic)
- gRPC client connections per runner

### Runner takes

| Current server.js lines | What | File |
|--------------------------|------|------|
| 276-335 | `getWorkerSystemPrompt`, `getOrchestratorPrompt` | `src/runner/prompts.js` |
| 409-541 | `runTask`, `runOrchestrator`, `runWorker` | `src/runner/executor.js` (refactored to use emit callback) |

### Runner gains (new)

- gRPC server with `RunnerService` implementation
- `Drain` support (stop accepting new tasks)
- `RUNNER_ID`, `RUNNER_SOCKET`, `RUNNER_MAX_TASKS` env var handling

## Migration Path (Incremental)

1. **Extract prompts** — Move system prompts to `src/runner/prompts.js`, import in current `server.js`. Pure refactor.

2. **Extract executor** — Move `runTask`/`runOrchestrator`/`runWorker` to `src/runner/executor.js`. Refactor to use `emit(type, payload)` callback instead of directly mutating the `tasks` Map. Current `server.js` provides the emit adapter. Still one process.

3. **Add proto + shared utils** — Create `proto/runner.proto`, `src/shared/proto-loader.js`, `src/shared/grpc-client.js`. Add `@grpc/grpc-js` and `@grpc/proto-loader` to `package.json`. No behavior change.

4. **Create Runner gRPC server** — `src/runner/server.js`. Can be tested standalone.

5. **Create Controller with single-runner support** — `src/controller/server.js` with hardcoded single gRPC client (same as original plan). Validates the gRPC protocol works end-to-end.

6. **Add RunnerPool + dockerode** — `src/controller/runner-pool.js`. Controller creates/manages Runner containers. Add `dockerode` dep.

7. **Add TaskRouter** — `src/controller/task-router.js`. Auto-routing with ephemeral runner creation.

8. **Add runner management HTTP API** — `POST/GET/DELETE /runners` endpoints.

9. **Docker split** — `Dockerfile.controller`, `Dockerfile.runner`, updated `docker-compose.yml`.

10. **Remove monolith** — Delete `src/server.js`.

## Configuration

All via environment variables:

### Controller

| Env Var | Default | Description |
|---------|---------|-------------|
| `PORT` | `3000` | HTTP listen port |
| `SOCKET_DIR` | `/var/run/claude-runners` | Shared directory for Runner UDS files |
| `RUNNER_IMAGE` | `claude-code-runner-runner:latest` | Docker image for Runner containers |
| `GITHUB_TOKEN` | (required) | Forwarded to Runners for git operations |
| `ANTHROPIC_API_KEY` | (optional) | Forwarded to Runners |
| `EPHEMERAL_IDLE_TIMEOUT` | `600000` (10min) | Ms before idle ephemeral runners are reaped |
| `HEALTH_CHECK_INTERVAL` | `15000` | Ms between runner health check sweeps |
| `RUNNER_MAX_TASKS` | `1` | Default max concurrent tasks for new runners |
| `CREDENTIALS_PATH` | `~/.claude/.credentials.json` | Host path to Claude credentials, mounted into runners |

### Runner

| Env Var | Default | Description |
|---------|---------|-------------|
| `RUNNER_ID` | (required) | Unique ID assigned by Controller |
| `RUNNER_SOCKET` | (required) | Unix socket path to listen on |
| `RUNNER_MAX_TASKS` | `1` | Max concurrent tasks this runner accepts |

## Known Challenges

1. **Socket directory permissions** — The bind-mounted volume must be writable by both Controller and Runner containers. Both run as `node` (UID 1000). If they have different UIDs, use a `--userns` mapping or run with matching UIDs.

2. **Docker socket security** — The Controller container has full Docker API access. This is powerful but risky. In production, consider using a Docker socket proxy (like Tecnativa/docker-socket-proxy) to limit API calls to container lifecycle operations only.

3. **Runner image availability** — The Runner Docker image must be pre-built and available to the Docker daemon. The `docker-compose build` step builds it. If using a registry, push the image and reference it by registry URL.

4. **Stale sockets** — If a Runner container is killed without cleanup, its `.sock` file remains. The Controller should `unlink` stale socket files when it detects a dead runner. Runners should also `unlink` their socket on startup if it exists.

5. **Container cleanup on Controller crash** — If the Controller dies, Runner containers keep running but are orphaned. On Controller restart, it should discover existing Runner containers (by label/name prefix) and reconnect or clean them up. Use Docker labels: `claude-runner.id=abc123`, `claude-runner.type=ephemeral`.

6. **Concurrent task limits** — Each Runner's `RUNNER_MAX_TASKS` controls parallelism. For Claude Code workloads (heavy CPU + memory), `1` is the safe default. Persistent runners handling lighter tasks could go to `2-3`.

7. **gRPC stream lifetime** — `ExecuteTask` streams can last up to 1 hour (worker timeout). Do NOT set gRPC deadlines on these calls. The Runner manages its own internal timeouts.

8. **Ephemeral runner startup latency** — Creating a new container takes 2-5 seconds. If this is too slow, maintain a small pool of "warm" ephemeral runners that are pre-created but idle. The idle reaper can maintain a minimum pool size.
