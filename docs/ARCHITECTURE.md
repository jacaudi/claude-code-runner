# Claude Code Runner - Architecture Documentation

A self-hosted service that accepts task prompts via HTTP and spawns Claude Code instances to autonomously implement them, creating pull requests in your GitHub repositories.

## Overview

Claude Code Runner enables "fire and forget" coding tasks. Submit a natural language prompt describing what you want done, and the service handles everything else: identifying the repository, cloning it, making changes, and opening a pull request.

```
HTTP Request → Express Server → Orchestrator Claude → Worker Claude → Pull Request
```

## Core Concepts

### Two-Phase Architecture

The system uses two separate Claude Code instances per task:

**Orchestrator Claude (Phase 1)**
- Receives the raw task prompt
- Parses the prompt to identify which repository is being referenced
- Uses `gh` CLI to search and find the target repository
- Clones the repository to a working directory
- Sets up the development environment (installs dependencies, tools)
- Creates and pushes a feature branch (`claude/<task-id>`)
- Exits after setup is complete

**Worker Claude (Phase 2)**
- Runs inside the cloned repository
- Has access to the repo's existing configuration (`.claude/`, `.mcp.json`, skills)
- Implements the actual task
- Creates a pull request with the changes
- Uses subagents for complex tasks to manage context
- On failure: commits current state, documents blockers in the PR, exits cleanly

### Why Two Phases?

1. **Separation of concerns**: Setup logic stays isolated from implementation logic
2. **Context preservation**: The worker starts fresh in the repo context with full context budget for the task
3. **Repository-specific configuration**: Worker inherits the target repo's Claude configuration
4. **Clean error handling**: Setup failures don't pollute implementation logs

## System Components

### Express Server (`src/server.js`)

The main application entry point providing:

- **Authentication system** (session-based for dashboard, Bearer token for API)
- **Task management** (in-memory Map, could be extended to database)
- **PTY process spawning** for Claude Code instances
- **Log streaming** from task output files
- **Dashboard serving** (static HTML files)

Key functions:
- `runTask()` - Orchestrates the two-phase execution
- `runOrchestrator()` - Spawns orchestrator Claude
- `runWorker()` - Spawns worker Claude
- `getOrchestratorPrompt()` - Constructs orchestrator system prompt
- `getWorkerSystemPrompt()` - Constructs worker system prompt

### Dashboard (`src/dashboard.html`)

Vanilla JavaScript single-page application providing:

- Task submission form
- Real-time task list with status indicators
- Log viewer modal with auto-refresh (2 second polling)
- API token management interface
- User authentication state

The dashboard auto-refreshes the task list every 5 seconds.

### Authentication Pages

- `src/setup.html` - First-time account creation
- `src/login.html` - Session login form

## Data Flow

### Task Submission

```
1. POST /task { prompt: "..." }
2. Generate task ID (8-char UUID prefix)
3. Create work directory: /tmp/work/<id>/
4. Store task in memory Map
5. Return { id, status: "queued" } immediately
6. Execute runTask() asynchronously
```

### Task Execution

```
1. Create log file: /tmp/work/<id>/output.log
2. Run orchestrator with 20-minute timeout
   - Spawns: claude -p <orchestrator-prompt> --dangerously-skip-permissions
   - Writes output to log file
   - On success: repo cloned to /tmp/work/<id>/repo/
3. Run worker with 1-hour timeout
   - Spawns: claude -p <task-prompt> --system-prompt <worker-system-prompt>
   - Runs inside /tmp/work/<id>/repo/
   - On success: PR URL extracted from output
4. Update task status: completed/failed
5. Clean up repo directory (keep logs)
```

### Process Spawning

Claude instances are spawned using `node-pty` (pseudo-terminal) rather than `child_process.spawn()`:

- Provides TTY environment that Claude Code expects
- Enables proper signal handling
- Captures colored/formatted output

Spawn configuration:
```javascript
pty.spawn('claude', [
  '-p', prompt,
  '--output-format', 'stream-json',
  '--verbose',
  '--dangerously-skip-permissions'
], {
  cwd: workingDirectory,
  env: { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN },
  cols: 200,
  rows: 50
})
```

## Authentication Architecture

### Two Auth Mechanisms

**Session-based (Dashboard users)**
- Express session with secure cookies
- 24-hour session duration
- Stored in memory (resets on container restart)

**Bearer token (API clients)**
- Prefixed tokens: `ccr_<uuid>`
- Stored in `/data/token.json`
- Persisted across restarts if volume mounted

### Auth Flow

```
Request → requireAuth middleware
  ├─ /setup, /api/setup (no auth if not configured)
  ├─ /login, /api/login (no auth)
  ├─ /health (no auth - for monitoring)
  ├─ Session authenticated? → Allow
  ├─ Bearer token valid? → Allow
  └─ Reject (401 or redirect to /login)
```

### First-Time Setup

1. Check if `/data/auth.json` exists with valid data
2. If not: redirect all routes to `/setup`
3. On setup: hash password with bcrypt (cost 12), save credentials
4. Auto-login user after setup

## Worker Constraints

The worker Claude has specific behavioral rules defined in its system prompt:

| Constraint | Reason |
|------------|--------|
| Never use `AskUserQuestion` | No human in the loop - would hang forever |
| Always push before exiting | Work is lost if not pushed |
| Aggressive subagent spawning | Preserve context window |
| Limit search commands to 3-4 | Use `Task` tool for exploration |
| Commit logical chunks | Like a software engineer would |
| Create PR at the end | Required deliverable |

On failure, the worker must:
1. Commit current state (even if incomplete)
2. Push to remote
3. Create PR documenting what went wrong

## Directory Structure

```
/app/                         # Application code
  src/
    server.js                 # Main application
    dashboard.html            # Dashboard UI
    login.html               # Login page
    setup.html               # Initial setup page

/tmp/work/                    # Task working directories
  <task-id>/
    output.log               # Combined orchestrator + worker logs
    repo/                    # Cloned repository (cleaned on success)

/data/                        # Persistent data (mount volume!)
  auth.json                  # User credentials (bcrypt hashed)
  token.json                 # API token

/home/node/.claude/           # Claude Code configuration
  .credentials.json          # OAuth credentials (mounted read-only from host)
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITHUB_TOKEN` | Yes | - | GitHub PAT with repo, read:org, workflow scopes |
| `PORT` | No | 3000 | HTTP server port |
| `SESSION_SECRET` | No | Random UUID | Express session secret |
| `DATA_DIR` | No | /data | Persistent data directory |
| `AUTH_FILE` | No | /data/auth.json | Credentials file path |
| `ANTHROPIC_API_KEY` | No | - | Optional API key (uses OAuth by default) |

## Docker Architecture

### Base Image

`node:20-slim` with additional packages:
- `git`, `ssh` - Version control
- `curl` - HTTP requests
- `python3`, `make`, `g++` - Native module compilation
- `jq` - JSON processing
- `gh` - GitHub CLI

### Security Considerations

- Runs as non-root user (`node`)
- OAuth credentials mounted read-only
- Work directories ephemeral (in `/tmp`)
- `/usr/local` and `/opt` writable for dynamic tool installation

### Volume Mounts

```yaml
volumes:
  # Required: OAuth credentials from host
  - ~/.claude/.credentials.json:/home/node/.claude/.credentials.json:ro

  # Recommended: Persistent auth/token storage
  - claude-data:/data
```

## API Reference

### Task Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /task | Yes | Submit new task |
| GET | /task/:id | Yes | Get task status |
| GET | /task/:id/logs | Yes | Stream task logs |
| GET | /tasks | Yes | List all tasks |

### Auth Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /setup | No | Setup page (first-time only) |
| POST | /api/setup | No | Create initial account |
| GET | /login | No | Login page |
| POST | /api/login | No | Authenticate |
| POST | /api/logout | Session | End session |
| GET | /api/me | Session | Current user info |

### Token Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /token/generate | Session | Generate new API token |
| GET | /token | No | Get masked token status |
| DELETE | /token | No | Revoke current token |

### Monitoring

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /health | No | Service health check |

## Task States

```
queued → running → completed
                 → failed
```

### Error Types

| Type | Meaning | Resolution |
|------|---------|------------|
| `auth_expired` | OAuth token expired | Re-authenticate `claude` on host |
| `capacity_reached` | Claude rate limited | Wait and retry |
| `timeout` | Task exceeded 1 hour | Break into smaller tasks |
| `exit_code` | Process exited non-zero | Check logs for details |

## Limitations

1. **Task storage**: In-memory only - tasks lost on restart
2. **No task queuing**: All tasks run immediately (resource intensive)
3. **Single-tenant**: One user/organization per instance
4. **No task cancellation**: Once started, tasks run to completion or timeout
5. **Session storage**: In-memory - sessions lost on restart
6. **PR extraction**: Simple regex match, may miss edge cases

## Extension Points

### Database Integration

Replace in-memory `Map` with database:
```javascript
// Current
const tasks = new Map();

// Could be
const tasks = new TaskRepository(database);
```

### Task Queue

Add job queue for controlled concurrency:
```javascript
// Add bull/agenda/etc.
taskQueue.add({ prompt, id });
taskQueue.process(concurrency, runTask);
```

### Webhooks

Notify external services on task completion:
```javascript
// In runWorker() on completion
await notifyWebhook(task.webhookUrl, { id, status, pr_url });
```

## Alternative: Unix Socket Communication

The server currently uses TCP (HTTP) for communication, but Unix sockets are a viable alternative for local or container-to-container communication.

### Implementation

Express supports Unix sockets natively. The change would be minimal:

```javascript
// Current (TCP)
app.listen(PORT, () => console.log(`Listening on :${PORT}`));

// Unix socket alternative
const SOCKET_PATH = process.env.SOCKET_PATH || '/tmp/claude-runner.sock';
app.listen(SOCKET_PATH, () => console.log(`Listening on ${SOCKET_PATH}`));
```

Client requests would use the socket path:

```bash
# TCP (current)
curl http://localhost:7334/task

# Unix socket
curl --unix-socket /tmp/claude-runner.sock http://localhost/task
```

Docker would mount the socket:

```yaml
volumes:
  - /tmp/claude-runner.sock:/tmp/claude-runner.sock
```

### Trade-offs

| Aspect | Unix Socket | TCP (Current) |
|--------|-------------|---------------|
| Performance | Slightly faster (no TCP overhead) | Minimal overhead |
| Security | File permissions control access | Requires auth middleware |
| Network access | Local only | Remote clients possible |
| Dashboard | Needs reverse proxy for browser | Works directly in browser |
| Monitoring tools | Harder (`curl` needs `--unix-socket`) | Standard HTTP tools work |
| Docker networking | Volume mount required | Port mapping works |

### Hybrid Approach

A robust implementation would support both:

```javascript
const SOCKET_PATH = process.env.SOCKET_PATH;
const PORT = process.env.PORT || 3000;

if (SOCKET_PATH) {
  // Clean up stale socket from previous run
  if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
  app.listen(SOCKET_PATH, () => console.log(`Listening on ${SOCKET_PATH}`));
} else {
  app.listen(PORT, () => console.log(`Listening on :${PORT}`));
}
```

This allows:
- Unix socket for local/container-to-container communication (faster, simpler auth via file permissions)
- TCP for dashboard browser access or remote API calls

### When to Consider Unix Sockets

- Container sidecar patterns (nginx → app in same pod)
- Local-only deployments where network exposure is undesirable
- High-throughput scenarios where TCP overhead matters
- Environments where file permission-based security is preferred over token auth

### Current Decision

TCP remains the default because:
1. Dashboard requires browser access (browsers don't support Unix sockets)
2. Remote API access is a common use case
3. Docker port mapping is simpler than socket volume mounts
4. Monitoring and debugging tools expect HTTP endpoints

## Kubernetes Deployment

### Quick Start

1. **Create namespace and secrets:**

```bash
kubectl apply -f k8s/namespace.yaml

# Encode your credentials
CREDS=$(cat ~/.claude/.credentials.json | base64)
TOKEN=$(echo -n "your-github-token" | base64)

# Edit k8s/secrets.yaml with your values, then:
kubectl apply -f k8s/secrets.yaml
```

2. **Deploy PostgreSQL:**

```bash
kubectl apply -f k8s/postgres.yaml

# Wait for postgres to be ready
kubectl -n claude-system wait --for=condition=ready pod -l app=postgres --timeout=60s

# Run migrations
kubectl -n claude-system exec -it deploy/postgres -- psql -U claude -d claude -c "
CREATE TABLE IF NOT EXISTS tasks (
    id VARCHAR(8) PRIMARY KEY,
    prompt TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    repository VARCHAR(255),
    branch VARCHAR(255),
    pr_url VARCHAR(255),
    error TEXT,
    error_type VARCHAR(50),
    worker_pod VARCHAR(255),
    worker_job VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW(),
    started_at TIMESTAMP,
    completed_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);
"
```

3. **Deploy controller:**

```bash
kubectl apply -f k8s/controller.yaml

# Wait for controller to be ready
kubectl -n claude-system wait --for=condition=ready pod -l app=claude-controller --timeout=60s
```

4. **Access the dashboard:**

```bash
# Port forward for local access
kubectl -n claude-system port-forward svc/claude-controller 7334:80

# Or apply ingress for external access
kubectl apply -f k8s/ingress.yaml
```

### Architecture in K8s Mode

When running in Kubernetes:

- **Controller** runs as a Deployment, creates K8s Jobs for tasks
- **Workers** run as ephemeral Jobs with 1-hour TTL after completion
- **PostgreSQL** stores task state (survives restarts)
- **Secrets** provide Claude credentials and GitHub token to workers

```
┌─────────────────────────────────────────┐
│           claude-system namespace        │
│                                          │
│  ┌──────────────┐    ┌──────────────┐   │
│  │  Controller  │───▶│  PostgreSQL  │   │
│  │  Deployment  │    │              │   │
│  └──────────────┘    └──────────────┘   │
│         │                                │
│         │ creates Jobs                   │
│         ▼                                │
│  ┌──────────────┐                        │
│  │ Worker Job 1 │──┐                     │
│  └──────────────┘  │                     │
│  ┌──────────────┐  │ callbacks           │
│  │ Worker Job 2 │──┼────────────────────▶│
│  └──────────────┘  │                     │
│        ...         │                     │
└────────────────────┘─────────────────────┘
```

## Deployment Recommendations

1. **Run behind VPN or private network** - Authentication is basic
2. **Mount persistent volume for `/data`** - Preserves credentials across restarts
3. **Set `SESSION_SECRET`** - Consistent sessions across container restarts
4. **Monitor `/health` endpoint** - Detect service issues
5. **Log rotation** - Task logs can grow large over time
6. **Resource limits** - Claude processes are memory-intensive

## CI/CD

### GitHub Actions Workflows

- `docker-publish.yml` - Builds and publishes Docker image on PR merge
- `release.yml` - Creates semantic versioned releases
- `promote-release.yml` - Promotes versions to `latest` tag

### Tagging Strategy

- Version tags (e.g., `1.4.1`) - Automatic on semantic release
- `latest` tag - Manually promoted stable release
