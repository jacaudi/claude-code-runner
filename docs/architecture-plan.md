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

The system supports **Projects** (registered git repos on GitHub, Forgejo, or GitLab) with **Issues** (bugs, features, dependency updates) that decompose into Tasks. See [Projects and Issues](./projects-and-issues.md) for the full design.

The Controller serves a single-page dashboard with four views: Tasks (one-off submission + table), Board (Kanban columns by status), Projects (registration + management), and Issues (list, sync from forge, task creation). See [UI Design](./ui-design.md) for the full design.

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
                        │  Config store (skills,  │        │              │
   POST /configs        │   rules, MCP, plans)    │        │              │
   GET  /configs        │  Artifact store          │        │              │
   GET  /task/:id/      │   (per-task outputs)    │        │              │
       artifacts        │                         │        │              │
                        └──────────┬──────────────┼────────┼─────────────┘
                                   │              │        │
                          gRPC over UDS           │        │ /var/run/docker.sock
                          /var/run/claude-runners/ │        │
                          runner-{id}.sock         │        │
                                   │              │        │
                           ┌───────┴──────┐       │        │
                           │  ConfigFiles │       │        │
                           │  ──────────► │       │        │
                           │  (in request)│       │        │
                           │              │       │        │
                           │  Artifacts   │       │        │
                           │  ◄────────── │       │        │
                           │  (in stream) │       │        │
                           └───────┬──────┘       │        │
                                   │              │        │
              ┌────────────────────┼──────────────┼────────┼──────────┐
              │                    │              │        ▼          │
              │    ┌───────────────┴──────────────┐   Docker Engine   │
              │    │         RUNNER (container)    │                  │
              │    │                               │                  │
              │    │  gRPC server (RunnerService)  │    ┌──────────┐ │
              │    │  Config deployer              │    │ Runner 2 │ │
              │    │  Task executor (node-pty)     │    └──────────┘ │
              │    │  Artifact collector           │    ┌──────────┐ │
              │    │  System prompts              │    │ Runner N │ │
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
| `ExecuteTask` | Server-streaming | Full task lifecycle. Request carries config files (skills, rules, MCP, plans). Stream carries logs, status, **artifacts**, and result. |
| `CancelTask` | Unary | Kill a running task via `AbortController` |
| `HealthCheck` | Unary | Verify Runner is alive, get running/max task counts, runner ID |
| `Drain` | Unary | Stop accepting new tasks, finish current ones. Used before teardown. |

Key proto messages for config sharing:

| Message | Direction | Purpose |
|---------|-----------|---------|
| `ConfigFile` | Controller → Runner | A file (skill, rule, MCP config, plan) sent in `ExecuteTaskRequest.config_files` |
| `Artifact` | Runner → Controller | A file produced during execution, streamed back as `TaskEvent{type:ARTIFACT}` |

The proto only defines the Runner-side service. Runner management and config storage are internal to the Controller and exposed via HTTP API.

## Directory Structure

```
claude-code-runner/
├── proto/
│   └── runner.proto                     # gRPC service definition
├── src/
│   ├── controller/
│   │   ├── server.js                    # Express app, auth, routes, startup
│   │   ├── db.js                        # SQLite setup, migrations, prepared statements
│   │   ├── runner-pool.js               # Runner lifecycle: create, destroy, health, reap
│   │   ├── task-router.js               # Decide which Runner gets a task
│   │   ├── project-manager.js           # Project CRUD, bare repo cache, worktree lifecycle
│   │   ├── issue-manager.js             # Issue CRUD, forge sync, status transitions
│   │   ├── config-store.js              # Config file storage + retrieval (skills, rules, MCP, plans)
│   │   ├── forge/                       # Forge abstraction layer
│   │   │   ├── index.js                 # ForgeClient base class + factory
│   │   │   ├── github.js               # GitHub (Octokit)
│   │   │   ├── gitlab.js               # GitLab (Gitbeaker)
│   │   │   └── forgejo.js              # Forgejo (Octokit + custom auth)
│   │   └── static/
│   │       ├── index.html           # SPA shell: nav, auth, hash router
│   │       ├── app.css              # All styles (dark theme, kanban, cards)
│   │       ├── views/
│   │       │   ├── tasks.js         # Tasks view (submit + table)
│   │       │   ├── board.js         # Kanban board (4 columns)
│   │       │   ├── projects.js      # Project registration + list
│   │       │   └── issues.js        # Issue list + detail + task creation
│   │       ├── components/
│   │       │   ├── task-card.js     # Task card (shared by board + task detail)
│   │       │   ├── log-viewer.js    # Log modal (extracted from old dashboard)
│   │       │   └── forms.js         # Modal forms, validation helpers
│   │       ├── login.html           # Pre-auth (standalone, no SPA)
│   │       └── setup.html           # First-run setup (standalone)
│   ├── runner/
│   │   ├── server.js                    # gRPC server, task management
│   │   ├── executor.js                  # Orchestrator + Worker phase execution
│   │   ├── config-deployer.js           # Write config files to filesystem before Claude runs
│   │   ├── artifact-collector.js        # Scan for plans/artifacts after Claude finishes
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

## Config Sharing: Controller → Runner

The Controller stores a library of configuration files (skills, MCP configs, rules, plans) and sends them to the Runner as part of each `ExecuteTaskRequest`. The Runner deploys them to the correct filesystem locations before spawning Claude.

### What Gets Shared

| Config Type | Claude Code Discovery Path | Format | Scope |
|-------------|---------------------------|--------|-------|
| **Skills** | `.claude/skills/<name>/SKILL.md` | YAML frontmatter + Markdown | Project or User |
| **MCP configs** | `.mcp.json` (project root) | JSON (`{mcpServers: {...}}`) | Project |
| **Rules** | `.claude/rules/*.md`, `.claude/CLAUDE.md` | Markdown (optional YAML frontmatter for path conditions) | Project or User |
| **Plans** | `.claude/plans/*.md` (configurable) | Plain Markdown | User (default) |

### Controller Config Store (`src/controller/config-store.js`)

The Controller persists config files on disk at `/data/configs/` and loads them into memory on startup.

```
/data/configs/
├── skills/
│   └── review/
│       └── SKILL.md            # Skill: /review slash command
├── rules/
│   ├── security.md             # Rule: security guidelines
│   └── code-style.md           # Rule: formatting conventions
├── mcp/
│   └── default.json            # MCP server config
└── plans/
    └── refactor-strategy.md    # Shared plan template
```

Each config file is stored with metadata:

```javascript
// Config entry shape in the store
{
  id: string,          // e.g. "cfg_a1b2c3d4"
  name: string,        // Human-readable name: "security-rules"
  type: 'skill' | 'mcp' | 'rule' | 'plan',
  scope: 'project' | 'user',
  path: string,        // Relative path: "rules/security.md"
  content: Buffer,     // Raw file content
  createdAt: Date,
  updatedAt: Date,
}
```

### HTTP API: Config Management

#### `POST /configs` — Upload a config file

```json
// Request
{
  "name": "security-rules",
  "type": "rule",
  "scope": "project",
  "path": "rules/security.md",
  "content": "# Security Rules\n\n- Never commit secrets..."
}

// Response
{
  "id": "cfg_a1b2c3d4",
  "name": "security-rules",
  "type": "rule",
  "scope": "project",
  "path": "rules/security.md",
  "createdAt": "2026-02-10T12:00:00Z"
}
```

#### `GET /configs` — List all configs

```json
[
  {
    "id": "cfg_a1b2c3d4",
    "name": "security-rules",
    "type": "rule",
    "scope": "project",
    "path": "rules/security.md",
    "size": 1234,
    "createdAt": "2026-02-10T12:00:00Z",
    "updatedAt": "2026-02-10T12:00:00Z"
  }
]
```

Optional query params: `?type=rule`, `?scope=project`

#### `GET /configs/:id` — Get config with content

Returns the full config entry including content.

#### `PUT /configs/:id` — Update a config

```json
{
  "content": "# Updated Security Rules\n\n- Never commit secrets..."
}
```

#### `DELETE /configs/:id` — Remove a config

### `POST /task` — Updated with config overrides

```json
{
  "prompt": "Add dark mode to the dashboard",
  "runnerId": "abc123",
  "configIds": ["cfg_a1b2c3d4", "cfg_e5f6g7h8"],
  "extraConfigs": [
    {
      "type": "rule",
      "scope": "project",
      "path": "rules/task-specific.md",
      "content": "# For This Task\n\nUse Tailwind CSS..."
    }
  ]
}
```

Config resolution for a task:

1. Start with all configs in the store (the "default set")
2. If `configIds` is provided, use **only those** instead of the default set
3. Merge in any `extraConfigs` (task-specific overrides, applied last)

### Runner Config Deployer (`src/runner/config-deployer.js`)

When the Runner receives an `ExecuteTaskRequest` with `config_files`, it writes them to disk before spawning Claude. The deployment path depends on `scope` and `type`:

```javascript
// src/runner/config-deployer.js

const HOME_CLAUDE = '/home/node/.claude';

export async function deployConfigs(configFiles, repoDir) {
  for (const cfg of configFiles) {
    const targetPath = resolveTargetPath(cfg, repoDir);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, cfg.content);
  }
}

function resolveTargetPath(cfg, repoDir) {
  const base = cfg.scope === 1 /* USER */ ? HOME_CLAUDE : repoDir;

  switch (cfg.type) {
    case 0: // SKILL -> .claude/skills/<path>
      return path.join(base, '.claude', 'skills', cfg.path);

    case 1: // MCP -> .mcp.json at project root, or settings.local.json for user
      if (cfg.scope === 1) {
        return path.join(HOME_CLAUDE, 'settings.local.json');
      }
      return path.join(base, '.mcp.json');

    case 2: // RULE -> .claude/rules/<path> or .claude/CLAUDE.md
      if (cfg.path === 'CLAUDE.md') {
        return path.join(base, '.claude', 'CLAUDE.md');
      }
      return path.join(base, '.claude', 'rules', cfg.path);

    case 3: // PLAN -> .claude/plans/<path>
      return path.join(base, '.claude', 'plans', cfg.path);

    case 4: // OTHER -> exact path
      return path.join(base, cfg.path);
  }
}
```

**Deployment timing**: Configs are deployed in two phases:
- **User-scoped configs** (`CONFIG_SCOPE_USER`): Deployed immediately when `ExecuteTask` is received, before the orchestrator phase. These go into `~/.claude/` and apply to all Claude invocations.
- **Project-scoped configs** (`CONFIG_SCOPE_PROJECT`): Deployed after the orchestrator phase clones the repo but before the worker phase. The Runner writes them into the cloned repo directory so the worker Claude picks them up.

### Deployment Sequence

```
ExecuteTaskRequest received (with config_files)
  │
  ├─ Deploy USER-scoped configs to ~/.claude/
  │   └─ ~/.claude/rules/*.md, ~/.claude/skills/*, ~/.claude/plans/*
  │
  ├─ Run Orchestrator phase (clones repo, creates branch)
  │
  ├─ Deploy PROJECT-scoped configs to <repo>/
  │   └─ <repo>/.claude/rules/*.md, <repo>/.mcp.json, <repo>/.claude/skills/*
  │
  └─ Run Worker phase (Claude discovers all configs automatically)
```

## Artifact Sharing: Runner → Controller

After the worker phase completes (or between phases), the Runner scans for files created by Claude and streams them back as `ARTIFACT` events.

### What Gets Collected

| Artifact Type | Scan Location | When |
|---------------|--------------|------|
| Plans | `~/.claude/plans/`, `<repo>/.claude/plans/` | After worker completes |
| Rules | `<repo>/.claude/rules/` (new/modified only) | After worker completes |
| Skills | `<repo>/.claude/skills/` (new/modified only) | After worker completes |

### Runner Artifact Collector (`src/runner/artifact-collector.js`)

```javascript
// src/runner/artifact-collector.js

export async function collectArtifacts(repoDir, emit, snapshotBefore) {
  // Compare filesystem state to snapshot taken before worker ran
  // Only collect NEW or MODIFIED files

  const artifacts = [];

  // 1. Scan plans directory
  const planDirs = [
    path.join('/home/node/.claude/plans'),
    path.join(repoDir, '.claude', 'plans'),
  ];
  for (const dir of planDirs) {
    for (const file of await listMarkdownFiles(dir)) {
      if (isNewOrModified(file, snapshotBefore)) {
        artifacts.push({
          path: path.relative(repoDir, file.path),
          content: await readFile(file.path),
          type: 0, // PLAN
        });
      }
    }
  }

  // 2. Scan rules directory (new/modified only)
  const rulesDir = path.join(repoDir, '.claude', 'rules');
  for (const file of await listMarkdownFiles(rulesDir)) {
    if (isNewOrModified(file, snapshotBefore)) {
      artifacts.push({
        path: path.relative(repoDir, file.path),
        content: await readFile(file.path),
        type: 1, // RULE
      });
    }
  }

  // 3. Scan skills directory (new/modified only)
  const skillsDir = path.join(repoDir, '.claude', 'skills');
  for (const file of await listMarkdownFiles(skillsDir)) {
    if (isNewOrModified(file, snapshotBefore)) {
      artifacts.push({
        path: path.relative(repoDir, file.path),
        content: await readFile(file.path),
        type: 2, // SKILL
      });
    }
  }

  // Stream each artifact back to Controller
  for (const artifact of artifacts) {
    emit('artifact', artifact);
  }

  return artifacts;
}

// Take snapshot of .claude/ directory before worker runs
export async function snapshotConfigDirs(repoDir) {
  // Returns Map<filePath, { mtime, size }> for diffing later
}
```

### Artifact Flow in Executor

```javascript
// In src/runner/executor.js (updated)

export async function executeTask(taskId, prompt, env, configFiles, emit, signal) {
  // 1. Deploy user-scoped configs
  const userConfigs = configFiles.filter(c => c.scope === 1);
  const projectConfigs = configFiles.filter(c => c.scope === 0);
  await deployConfigs(userConfigs, null);

  // 2. Run orchestrator (clones repo)
  emit('status', { status: 'running', phase: 'orchestrator' });
  await runPhase('orchestrator', ...);

  // 3. Deploy project-scoped configs into cloned repo
  await deployConfigs(projectConfigs, repoDir);

  // 4. Snapshot .claude/ dirs before worker runs
  const snapshot = await snapshotConfigDirs(repoDir);

  // 5. Run worker
  emit('status', { status: 'running', phase: 'worker' });
  const output = await runPhase('worker', ...);

  // 6. Collect and stream artifacts
  await collectArtifacts(repoDir, emit, snapshot);

  // 7. Return result
  return { success: true, ... };
}
```

### Controller Artifact Storage

The Controller stores artifacts in memory per task (alongside logs):

```javascript
// Task entry shape (updated)
{
  status: 'running',
  prompt: '...',
  logLines: [],
  artifacts: [           // NEW
    {
      path: '.claude/plans/refactor.md',
      content: Buffer,
      type: 'plan',
      receivedAt: '2026-02-10T14:30:00Z'
    }
  ],
  // ... other fields
}
```

### HTTP API: Artifact Retrieval

#### `GET /task/:id/artifacts` — List artifacts from a task

```json
[
  {
    "path": ".claude/plans/refactor.md",
    "type": "plan",
    "size": 2048,
    "receivedAt": "2026-02-10T14:30:00Z"
  }
]
```

#### `GET /task/:id/artifacts/*path` — Get artifact content

Returns raw file content with appropriate Content-Type.

#### `POST /task/:id/artifacts/:path/promote` — Save artifact as a config

Takes an artifact produced by a task and saves it into the config store, making it available for future tasks.

```json
// Request
{
  "name": "refactor-plan",
  "scope": "project"
}

// Response
{
  "configId": "cfg_x9y8z7",
  "name": "refactor-plan",
  "type": "plan",
  "path": "plans/refactor.md"
}
```

This is the key feedback loop: Runner creates a plan → Controller receives it as an artifact → User promotes it to a config → Future tasks receive it automatically.

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
                       ├─ Resolve config files (store defaults + configIds + extraConfigs)
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
                   runner.grpcClient.ExecuteTask({
                     task_id, prompt, github_token,
                     config_files: [skills, rules, mcp, plans]   ◄── configs sent here
                   })
                       │
                  gRPC stream (unix:///var/run/claude-runners/runner-{id}.sock)
                       │
                       ▼
                   Runner container
                     │
                     ├─ Deploy USER-scoped configs to ~/.claude/
                     ├─ emit STATUS_CHANGE(running, orchestrator)
                     ├─ spawn claude CLI (orchestrator, 20min timeout)
                     ├─ emit LOG lines
                     ├─ Deploy PROJECT-scoped configs to <repo>/
                     ├─ Snapshot .claude/ dirs (for artifact diffing)
                     ├─ emit STATUS_CHANGE(running, worker)
                     ├─ spawn claude CLI (worker, 1hr timeout)
                     ├─ emit LOG lines
                     ├─ Collect new/modified artifacts (plans, rules, skills)
                     ├─ emit ARTIFACT events for each                      ◄── artifacts sent back
                     └─ emit RESULT(success, pr_url, ...)
                       │
                  stream closes
                       │
                       ▼
                   Controller
                     │
                     ├─ Updates task in Map (status, pr_url, error, logs)
                     ├─ Stores received artifacts in task.artifacts[]
                     ├─ Updates runner.runningTasks--
                     └─ Updates runner.lastTaskAt = now
                              │
                              └─ (ephemeral idle reaper checks later:
                                  if no tasks for 10min → drain & destroy)

User ──GET /task/:id/artifacts──► Controller ──► list of plans/files created
User ──POST /task/:id/artifacts/:path/promote──► saves artifact as config for future tasks
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
  "dockerode": "^4.0.0",
  "better-sqlite3": "^11.0.0",
  "@octokit/rest": "^21.0.0",
  "@gitbeaker/rest": "^40.0.0"
}
```

- `@grpc/grpc-js` + `@grpc/proto-loader` — gRPC on both Controller (client) and Runner (server)
- `dockerode` — Controller only, for Docker container management
- `better-sqlite3` — Controller only, persistence for projects/issues/tasks
- `@octokit/rest` — Controller only, GitHub + Forgejo API client
- `@gitbeaker/rest` — Controller only, GitLab API client
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
- `POST/GET/PUT/DELETE /configs` endpoints (config store management)
- `GET /task/:id/artifacts` and `POST /task/:id/artifacts/:path/promote` endpoints
- `RunnerPool` class (Docker lifecycle management)
- `TaskRouter` class (runner selection logic)
- `ConfigStore` class (config file persistence and resolution)
- gRPC client connections per runner

### Runner takes

| Current server.js lines | What | File |
|--------------------------|------|------|
| 276-335 | `getWorkerSystemPrompt`, `getOrchestratorPrompt` | `src/runner/prompts.js` |
| 409-541 | `runTask`, `runOrchestrator`, `runWorker` | `src/runner/executor.js` (refactored to use emit callback) |

### Runner gains (new)

- gRPC server with `RunnerService` implementation
- `ConfigDeployer` — writes received config files to correct paths before Claude runs
- `ArtifactCollector` — scans for new/modified plans, rules, skills after Claude finishes
- `Drain` support (stop accepting new tasks)
- `RUNNER_ID`, `RUNNER_SOCKET`, `RUNNER_MAX_TASKS` env var handling

## Migration Path (Incremental)

1. **Extract prompts** — Move system prompts to `src/runner/prompts.js`, import in current `server.js`. Pure refactor.

2. **Extract executor** — Move `runTask`/`runOrchestrator`/`runWorker` to `src/runner/executor.js`. Refactor to use `emit(type, payload)` callback instead of directly mutating the `tasks` Map. Current `server.js` provides the emit adapter. Still one process.

3. **Add proto + shared utils** — Create `proto/runner.proto`, `src/shared/proto-loader.js`, `src/shared/grpc-client.js`. Add `@grpc/grpc-js` and `@grpc/proto-loader` to `package.json`. No behavior change.

4. **Create Runner gRPC server** — `src/runner/server.js`. Can be tested standalone.

5. **Create Controller with single-runner support** — `src/controller/server.js` with hardcoded single gRPC client. Validates the gRPC protocol works end-to-end.

6. **Add config deployer + artifact collector** — `src/runner/config-deployer.js` and `src/runner/artifact-collector.js`. Integrate into executor: deploy configs before Claude, collect artifacts after.

7. **Add ConfigStore + config HTTP API** — `src/controller/config-store.js`. `POST/GET/PUT/DELETE /configs` endpoints. Store persists to `/data/configs/`.

8. **Add artifact HTTP API** — `GET /task/:id/artifacts`, `POST /task/:id/artifacts/:path/promote`. Controller accumulates artifacts from gRPC stream.

9. **Add RunnerPool + dockerode** — `src/controller/runner-pool.js`. Controller creates/manages Runner containers. Add `dockerode` dep.

10. **Add TaskRouter** — `src/controller/task-router.js`. Auto-routing with ephemeral runner creation.

11. **Add runner management HTTP API** — `POST/GET/DELETE /runners` endpoints.

12. **Add SQLite persistence** — `src/controller/db.js`. Migrate in-memory task `Map` to SQLite. Tasks persist across restarts.

13. **Add Project Manager** — `src/controller/project-manager.js`. Project registration, bare repo cloning, worktree lifecycle. `POST/GET/DELETE /projects`.

14. **Add Forge abstraction** — `src/controller/forge/`. GitHub implementation first. Issue sync, PR comments.

15. **Add Issue Manager** — `src/controller/issue-manager.js`. Issue CRUD, lifecycle transitions. `POST/GET/PATCH /projects/:id/issues`, `POST /issues/:id/tasks`.

16. **Wire project_context into task dispatch** — When a task has a project, Controller creates worktree, mounts into Runner, sends `ProjectContext`. Runner skips orchestrator.

17. **Add GitLab + Forgejo forge implementations** — Complete multi-forge support.

18. **Refactor dashboard into SPA** — Extract `dashboard.html` into `index.html` shell + `app.css` + `views/tasks.js` + `components/log-viewer.js`. Hash router. Same functionality, modular code.

19. **Add Kanban board view** — `views/board.js`. Four-column layout (Queued, Running, Completed, Failed). Task cards with status colors, cancel button, log viewer.

20. **Add Projects view** — `views/projects.js`. Register project modal with forge auto-detection. Project cards with issue counts, sync button, settings.

21. **Add Issues view** — `views/issues.js`. Filterable issue list with collapsible cards. Create-task-from-issue modal with pre-filled prompt. Issue creation with forge sync.

22. **Docker split** — `Dockerfile.controller`, `Dockerfile.runner`, updated `docker-compose.yml`.

23. **Remove monolith** — Delete `src/server.js`.

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

9. **Config file size in gRPC messages** — Config files are sent inline in the `ExecuteTaskRequest` protobuf message. Skills and MCP configs are typically small (< 10KB). If a config set grows large (many skills, large plan files), the gRPC message could exceed the default 4MB limit. Mitigate by setting `grpc.max_send_message_length` and `grpc.max_receive_message_length` on both client and server (e.g., 16MB), or by mounting a shared config volume instead of inline transfer.

10. **Project-scoped config deployment timing** — Project-scoped configs must be deployed AFTER the orchestrator clones the repo but BEFORE the worker runs. The executor must split config deployment into two phases. If the orchestrator fails (no repo cloned), project-scoped configs are skipped gracefully.

11. **Artifact diffing accuracy** — The artifact collector compares filesystem state before and after the worker runs. Files modified by git operations (checkout, merge) should not be treated as artifacts. The collector only scans `.claude/plans/`, `.claude/rules/`, and `.claude/skills/` directories — not the entire repo — to avoid false positives.

12. **Promoting artifacts as configs** — When a user promotes an artifact to a config, the Controller must validate the content (is it valid markdown? valid JSON for MCP?) before persisting. Invalid configs could break future task executions.
