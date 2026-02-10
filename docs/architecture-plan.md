# Architecture Plan: Controller/Runner Split via gRPC

## Overview

Split the monolithic `src/server.js` into two independently runnable processes:

- **Controller** — Owns the HTTP API, dashboard UI, authentication, session management, and task state. User-facing. Delegates execution to Runner via gRPC.
- **Runner** — Owns Claude process spawning (orchestrator + worker phases via `node-pty`), log capture, and Docker container management. Receives work via gRPC.

Communication: gRPC over Unix domain socket (`unix:///tmp/claude-runner.sock`) using `@grpc/grpc-js` + `@grpc/proto-loader`.

## Architecture Diagram

```
                    ┌──────────────────────────────────────┐
   HTTP :3000       │           CONTROLLER                 │
   ─────────────────│                                      │
   POST /task       │  Express server                      │
   GET /task/:id    │  Auth (session + bearer)             │
   GET /tasks       │  Dashboard UI                        │
   GET /health      │  Task state (in-memory Map)          │
                    │  Log buffer (in-memory per task)     │
                    └──────────────┬───────────────────────┘
                                   │
                                   │ gRPC over Unix socket
                                   │ /shared/claude-runner.sock
                                   │
                    ┌──────────────┴───────────────────────┐
                    │             RUNNER                    │
                    │                                      │
                    │  gRPC server (RunnerService)          │
                    │  Task executor (node-pty)             │
                    │  Orchestrator + Worker phases         │
                    │  System prompts                       │
                    │  Docker socket access (future)        │
                    └──────────────────────────────────────┘
```

## Proto Definition

See `proto/runner.proto`. Three RPCs:

| RPC | Type | Purpose |
|-----|------|---------|
| `ExecuteTask` | Server-streaming | Full task lifecycle — logs, status changes, and final result flow as `TaskEvent` messages |
| `CancelTask` | Unary | Kill a running task via `AbortController` |
| `HealthCheck` | Unary | Verify Runner is alive, get running task count |

## Directory Structure

```
claude-code-runner/
├── proto/
│   └── runner.proto                 # gRPC service definition
├── src/
│   ├── controller/
│   │   ├── server.js                # Express app, auth, routes, gRPC client
│   │   └── static/
│   │       ├── dashboard.html       # Moved from src/
│   │       ├── login.html
│   │       └── setup.html
│   ├── runner/
│   │   ├── server.js                # gRPC server, task management
│   │   ├── executor.js              # runTask/runOrchestrator/runWorker
│   │   └── prompts.js               # System prompt generators
│   └── shared/
│       ├── grpc-client.js           # gRPC client factory with UDS config
│       └── proto-loader.js          # Loads runner.proto
├── Dockerfile.controller            # Lightweight: Node.js + curl only
├── Dockerfile.runner                # Full: Node.js + gh CLI + Claude Code + build tools
├── docker-compose.yml               # Two services, shared socket volume
└── package.json
```

## What Goes Where

### Controller keeps (from current server.js)

- Express setup, session config (lines 1-29)
- Auth file management, `requireAuth` middleware (lines 31-131)
- `tasks` Map and constants (lines 136-137) — **minus** `WORK_DIR`
- All auth routes: setup, login, logout, me, token CRUD (lines 140-272)
- Task HTTP routes: POST /task, GET /task/:id, GET /tasks, GET /health (lines 338-406)
- Dashboard/HTML serving

### Controller changes

- `POST /task` calls `runnerClient.ExecuteTask()` instead of `runTask()`
- `GET /task/:id/logs` reads from `task.logLines[]` (in-memory) instead of file
- `/health` also queries Runner via `HealthCheck` RPC
- **No `node-pty` dependency**

### Runner takes (from current server.js)

- `getWorkerSystemPrompt()` and `getOrchestratorPrompt()` (lines 274-335)
- `runTask()`, `runOrchestrator()`, `runWorker()` (lines 409-541)
- Refactored to emit events via callback instead of modifying Map directly

## Task Lifecycle Flow

```
User ──POST /task──> Controller
                       │
                       ├─ Create task in Map {status:'queued'}
                       ├─ Return {id, status:'queued'} immediately
                       │
                       └─ runnerClient.ExecuteTask(request)
                                │
                          gRPC stream
                                │
                                ▼
                            Runner
                              │
                              ├─ mkdir /tmp/work/<task_id>
                              ├─ emit STATUS_CHANGE(running, orchestrator)
                              ├─ spawn claude CLI (orchestrator phase, 20min timeout)
                              ├─ emit LOG lines as they arrive
                              ├─ emit STATUS_CHANGE(running, worker)
                              ├─ spawn claude CLI (worker phase, 1hr timeout)
                              ├─ emit LOG lines as they arrive
                              ├─ extract PR URL from output
                              └─ emit RESULT(success, pr_url, ...)
                                │
                          stream closes
                                │
                                ▼
                           Controller
                              │
                              ├─ Updates task.status, task.pr_url, etc.
                              └─ task.logLines[] accumulated from LOG events

User ──GET /task/:id──> Controller ──> Returns current state
User ──GET /task/:id/logs──> Controller ──> Returns logLines.join('\n')
```

## Log Streaming

- **Runner**: Each `proc.onData(data)` chunk from `node-pty` is split into lines and sent as `TaskEvent{type:LOG}`
- **Controller**: Accumulates in `task.logLines[]` array
- **Dashboard**: Fetches `/task/:id/logs` (plain text) — no changes needed to dashboard.html

## Error Handling Across gRPC

| Scenario | Propagation |
|----------|-------------|
| Orchestrator/Worker timeout | Runner emits `RESULT{error_type:'timeout'}`, stream closes normally |
| Non-zero exit code | Runner emits `RESULT{error_type:'exit_code'}` |
| Runner process crash | gRPC stream error on Controller; task marked `failed` with `errorType:'runner_error'` |
| Socket disconnect | Same as crash |
| Task cancellation | Controller calls `CancelTask` RPC; Runner aborts via `AbortController`; emits `RESULT{error_type:'cancelled'}` |

No gRPC deadline on `ExecuteTask` — Runner manages its own timeouts internally.

## Docker Compose

```yaml
services:
  controller:
    build:
      context: .
      dockerfile: Dockerfile.controller
    ports:
      - "7334:3000"
    environment:
      - GITHUB_TOKEN=${GITHUB_TOKEN}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
      - PORT=3000
      - RUNNER_SOCKET=/shared/claude-runner.sock
    volumes:
      - claude-data:/data
      - runner-socket:/shared
    depends_on:
      runner:
        condition: service_started

  runner:
    build:
      context: .
      dockerfile: Dockerfile.runner
    environment:
      - RUNNER_SOCKET=/shared/claude-runner.sock
    volumes:
      - ~/.claude/.credentials.json:/home/node/.claude/.credentials.json:ro
      - runner-socket:/shared
      # Future: - /var/run/docker.sock:/var/run/docker.sock

volumes:
  claude-data:
  runner-socket:
    driver: local
    driver_opts:
      type: tmpfs
      device: tmpfs
```

Key: Unix socket shared via tmpfs-backed volume between containers.

## New Dependencies

```json
{
  "@grpc/grpc-js": "^1.10.0",
  "@grpc/proto-loader": "^0.7.12"
}
```

`node-pty` becomes Runner-only. Controller doesn't need it.

## gRPC Unix Socket Gotcha

Must set `grpc.default_authority: 'localhost'` on all client connections:

```javascript
const client = new RunnerService(
  'unix:///shared/claude-runner.sock',
  grpc.credentials.createInsecure(),
  { 'grpc.default_authority': 'localhost' }
);
```

Without this, HTTP/2 over UDS fails with `PROTOCOL_ERROR`.

## Migration Path (Incremental)

1. **Extract prompts** — Move system prompt functions to `src/runner/prompts.js`, import in current `server.js`
2. **Extract executor** — Move `runTask`/`runOrchestrator`/`runWorker` to `src/runner/executor.js`, refactor to use `emit` callback
3. **Add proto + shared utils** — Create `proto/runner.proto`, `src/shared/proto-loader.js`, `src/shared/grpc-client.js`; add gRPC deps
4. **Create Runner gRPC server** — `src/runner/server.js` wrapping executor with gRPC
5. **Create Controller** — `src/controller/server.js` with gRPC client replacing direct execution
6. **Update scripts** — Add `start:controller` and `start:runner` to package.json
7. **Docker split** — Create `Dockerfile.controller`, `Dockerfile.runner`, update `docker-compose.yml`
8. **Remove monolith** — Delete `src/server.js` once validated

## Known Challenges

1. **UDS permissions in Docker** — tmpfs volume avoids filesystem permission issues; both containers run as `node` (UID 1000)
2. **Proto enum values** — Use `enums: Number` in proto-loader options, match integers in switch statements
3. **Stream backpressure** — gRPC default flow control handles this; monitor memory if tasks produce extreme log volume
4. **Runner restart** — Stale socket file cleaned up on startup via `unlinkSync`; Controller marks in-flight tasks as failed via stream error handler
5. **Multiple Runners** — Current design is single-Runner; `grpc-client.js` structured to support multiple clients for future scale-out
