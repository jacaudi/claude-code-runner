# Architecture

A self-hosted service that accepts task prompts via HTTP and spawns Claude Code instances to autonomously implement them, creating pull requests in your GitHub repositories.

## Overview

```
HTTP Request → Controller → Worker (local PTY or K8s Job) → Pull Request
```

**Deployment modes:**
- **Docker (local)**: Controller spawns workers via PTY, in-memory task storage
- **Docker + PostgreSQL**: Same as above with persistent task storage
- **Kubernetes**: Controller creates K8s Jobs for workers, PostgreSQL for state

## Two-Phase Architecture

Each task uses two Claude Code instances:

**Orchestrator (Phase 1)** - Setup
- Parses prompt to identify target repository
- Clones repo via `gh` CLI
- Creates feature branch (`claude/<task-id>`)
- Exits after setup

**Worker (Phase 2)** - Implementation
- Runs inside cloned repo with its `.claude/` config
- Implements the task
- Commits, pushes, creates PR
- On failure: commits state, documents blockers in PR

## System Components

| Component | File | Purpose |
|-----------|------|---------|
| Server | `src/server.js` | HTTP API, task orchestration |
| Dashboard | `src/dashboard.html` | Web UI for task submission/monitoring |
| DB Module | `src/db.js` | PostgreSQL persistence (optional) |
| K8s Module | `src/k8s.js` | Kubernetes Job management (optional) |
| Worker | `src/worker.js` | K8s worker pod entrypoint |

## Data Flow

```
1. POST /task { prompt }
2. Generate task ID (8-char UUID)
3. Store task (memory or PostgreSQL)
4. If K8s mode: create Job, else: spawn PTY
5. Worker executes task (20min orchestrator + 1hr worker timeout)
6. Update task status, extract PR URL
```

## Authentication

**Two mechanisms:**
- **Session** (dashboard): Express session, 24hr duration
- **Bearer token** (API): `ccr_<uuid>` prefix, stored in `/data/token.json`

**Flow:**
```
Request → requireAuth middleware
  ├─ /health, /login, /setup → Allow (public)
  ├─ Session valid? → Allow
  ├─ Bearer token valid? → Allow
  └─ Reject (401)
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITHUB_TOKEN` | Yes | - | GitHub PAT with repo scope |
| `PORT` | No | 3000 | HTTP server port |
| `SESSION_SECRET` | No | Random | Express session secret |
| `DATABASE_URL` | No | - | PostgreSQL connection string |
| `NAMESPACE` | No | default | K8s namespace for workers |
| `WORKER_IMAGE` | No | - | Docker image for K8s workers |
| `CONTROLLER_SERVICE` | No | - | K8s service name for callbacks |

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
| POST | /api/setup | No | Create initial account |
| POST | /api/login | No | Authenticate |
| POST | /api/logout | Session | End session |
| POST | /token/generate | Session | Generate API token |
| GET | /health | No | Health check |

### Internal Endpoints (K8s mode)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /internal/task/:id/status | No* | Worker callback |

*Protected by cluster network policy

## Task States

```
pending → running → completed
                  → failed
```

**Error types:**
| Type | Meaning |
|------|---------|
| `auth_expired` | Re-authenticate `claude` on host |
| `capacity_reached` | Claude rate limited, retry later |
| `timeout` | Task exceeded 1 hour |
| `job_creation_failed` | K8s Job creation failed |

## Kubernetes Deployment

### Quick Start

```bash
# 1. Create namespace and secrets
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/secrets.yaml   # Edit first with your values

# 2. Deploy PostgreSQL
kubectl apply -f k8s/postgres.yaml
kubectl -n claude-system wait --for=condition=ready pod -l app=postgres

# 3. Run migrations
DATABASE_URL="postgresql://claude:password@localhost:5432/claude" npm run db:migrate

# 4. Deploy controller
kubectl apply -f k8s/controller.yaml

# 5. Access dashboard
kubectl -n claude-system port-forward svc/claude-controller 7334:80
```

### K8s Architecture

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
│  └──────────────┘  │ callbacks           │
│  ┌──────────────┐  │                     │
│  │ Worker Job 2 │──┼────────────────────▶│
│  └──────────────┘  │                     │
└────────────────────┴─────────────────────┘
```

**Components:**
- **Controller**: Deployment with RBAC for Job management
- **Workers**: Ephemeral Jobs with 1hr TTL after completion
- **PostgreSQL**: Task state persistence
- **Secrets**: Claude credentials and GitHub token

### K8s Manifests

| File | Contents |
|------|----------|
| `k8s/namespace.yaml` | `claude-system` namespace |
| `k8s/secrets.yaml` | Credentials template |
| `k8s/postgres.yaml` | PostgreSQL Deployment, Service, PVC |
| `k8s/controller.yaml` | ServiceAccount, Role, RoleBinding, Deployment, Service |
| `k8s/ingress.yaml` | Optional ingress for external access |

## Docker Architecture

**Base image:** `node:20-slim` with git, gh, python3, make, g++, jq

**Volume mounts:**
```yaml
volumes:
  - ~/.claude/.credentials.json:/home/node/.claude/.credentials.json:ro
  - claude-data:/data
```

**Security:**
- Runs as non-root (`node` user)
- OAuth credentials read-only
- Work directories ephemeral (`/tmp`)

## Directory Structure

```
/app/src/
  server.js          # Main application
  db.js              # PostgreSQL module
  k8s.js             # Kubernetes module
  worker.js          # K8s worker entrypoint
  dashboard.html     # Web UI
/tmp/work/<task-id>/ # Task working directories
/data/               # Persistent auth/tokens (mount volume)
```

## Worker Constraints

| Constraint | Reason |
|------------|--------|
| Never use `AskUserQuestion` | No human in loop |
| Always push before exiting | Work lost if not pushed |
| Aggressive subagent spawning | Preserve context |
| Create PR at the end | Required deliverable |

On failure: commit current state, push, create PR documenting blockers.

## Deployment Recommendations

1. **Run behind VPN** - Authentication is basic
2. **Mount `/data` volume** - Preserves credentials
3. **Set `SESSION_SECRET`** - Consistent sessions
4. **Monitor `/health`** - Detect issues
5. **Set resource limits** - Claude is memory-intensive
