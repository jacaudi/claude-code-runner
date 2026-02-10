# Projects, Issues, and Task Workflows

This document extends the [architecture plan](./architecture-plan.md) with structured project management, multi-forge integration, and an Issue → Task hierarchy.

## Motivation

The current architecture treats every task as ad-hoc: user sends a prompt, the orchestrator Claude guesses which repo to work on, clones it, and starts working. This works but has problems:

1. **Repo discovery is fragile** — Claude has to guess the right repo from the prompt
2. **No parallelism** — Every task does a full clone, even for the same repo
3. **No work tracking** — Tasks are fire-and-forget with no relationship to each other
4. **GitHub-only** — The orchestrator hard-codes `gh` CLI and GitHub URLs

Projects and Issues solve all of these by introducing structure above the task layer.

## Data Model

```
┌──────────────────────────────────────────────────────────┐
│                        PROJECT                            │
│  A git repo (GitHub, Forgejo, or GitLab).                │
│  Registered once. Cached as bare repo.                   │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │                      ISSUE                          │  │
│  │  A unit of planned work (bug, feature, dep update). │  │
│  │  Synced to/from forge. Has lifecycle.               │  │
│  │                                                     │  │
│  │  ┌──────────────────────────────────────────────┐   │  │
│  │  │                    TASK                       │   │  │
│  │  │  A single Claude execution. The actual work.  │   │  │
│  │  │  Runs in a worktree. Produces a PR.          │   │  │
│  │  └──────────────────────────────────────────────┘   │  │
│  │  ┌──────────────────────────────────────────────┐   │  │
│  │  │                    TASK                       │   │  │
│  │  │  (an issue can have multiple tasks:           │   │  │
│  │  │   plan, implement, test, fix review comments) │   │  │
│  │  └──────────────────────────────────────────────┘   │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  Tasks can also exist without an Issue (ad-hoc work).    │
│  Tasks can also exist without a Project (legacy mode).   │
└──────────────────────────────────────────────────────────┘
```

### Relationships

- A **Project** has many Issues and many Tasks
- An **Issue** belongs to one Project, has many Tasks
- A **Task** optionally belongs to a Project and optionally belongs to an Issue
- Tasks without a Project run in legacy mode (orchestrator guesses repo)
- Tasks without an Issue are ad-hoc project work (no tracking)

## Persistence: SQLite

The in-memory `Map` for tasks doesn't scale to relational data. We add `better-sqlite3` for structured persistence.

**Why SQLite:**
- Embedded, no external server
- WAL mode for concurrent reads during task execution
- Synchronous API (simpler than async alternatives)
- Single file, easy to backup/restore
- Can swap for PostgreSQL later if multi-controller is needed

**Database location:** `/data/claude-runner.db`

### Schema

```sql
-- Projects: registered git repositories
CREATE TABLE projects (
  id            TEXT PRIMARY KEY,              -- "proj_a1b2c3d4"
  name          TEXT NOT NULL,                 -- "my-api"
  forge_type    TEXT NOT NULL,                 -- "github" | "forgejo" | "gitlab"
  clone_url     TEXT NOT NULL,                 -- "https://github.com/org/my-api.git"
  default_branch TEXT DEFAULT 'main',
  forge_owner   TEXT,                          -- "org"
  forge_repo    TEXT,                          -- "my-api"
  forge_base_url TEXT,                         -- "https://github.com" (for self-hosted)
  forge_api_token TEXT,                        -- Per-project token override (nullable)
  local_bare_path TEXT,                        -- "/data/repos/my-api.git"
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

-- Issues: tracked work items synced with forge
CREATE TABLE issues (
  id              TEXT PRIMARY KEY,            -- "iss_e5f6g7h8"
  project_id      TEXT NOT NULL REFERENCES projects(id),
  title           TEXT NOT NULL,
  body            TEXT,
  type            TEXT DEFAULT 'feature',      -- "bug" | "feature" | "dependency" | "chore"
  status          TEXT DEFAULT 'open',         -- "open" | "in_progress" | "resolved" | "closed"
  priority        TEXT DEFAULT 'medium',       -- "low" | "medium" | "high" | "critical"
  forge_number    INTEGER,                     -- Issue number on forge (e.g. #42)
  forge_url       TEXT,                        -- Full URL to issue on forge
  labels          TEXT,                        -- JSON array: ["bug", "auth"]
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_issues_project ON issues(project_id);
CREATE INDEX idx_issues_status ON issues(status);

-- Tasks: individual Claude executions
CREATE TABLE tasks (
  id              TEXT PRIMARY KEY,            -- "task_i9j0k1l2"
  project_id      TEXT REFERENCES projects(id),  -- Nullable for ad-hoc tasks
  issue_id        TEXT REFERENCES issues(id),    -- Nullable for non-issue work
  prompt          TEXT NOT NULL,
  status          TEXT DEFAULT 'queued',       -- "queued" | "running" | "completed" | "failed"
  runner_id       TEXT,
  branch_name     TEXT,
  worktree_path   TEXT,
  pr_url          TEXT,
  error           TEXT,
  error_type      TEXT,
  started_at      TEXT,
  finished_at     TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_issue ON tasks(issue_id);
CREATE INDEX idx_tasks_status ON tasks(status);
```

Logs and artifacts remain in-memory (they're transient and large). Tasks, projects, and issues persist across restarts.

## Forge Abstraction Layer

### Interface

```javascript
// src/controller/forge/index.js

export class ForgeClient {
  // Issues
  async listIssues(filters) { }
  async getIssue(number) { }
  async createIssue({ title, body, labels }) { }
  async updateIssue(number, updates) { }
  async closeIssue(number) { }
  async addIssueComment(number, body) { }

  // Pull/Merge Requests
  async createPR({ title, body, head, base }) { }
  async addPRComment(number, body) { }

  // Sync
  async syncIssues() { }             // Import open issues from forge
  async registerWebhook(url) { }     // Real-time updates (optional)
}
```

### Implementations

| Method | GitHub | GitLab | Forgejo |
|--------|--------|--------|---------|
| Client lib | `@octokit/rest` | `@gitbeaker/rest` | `@octokit/rest` (custom baseUrl) |
| Issue ref field | `number` | `iid` | `number` |
| Body field | `body` | `description` | `body` |
| Labels format | Objects `{name,color}` | Strings | Objects `{name,color}` |
| State: open | `"open"` | `"opened"` | `"open"` |
| PR/MR term | Pull Request | Merge Request | Pull Request |
| Auth header | `Bearer <token>` | `Bearer <token>` | `token <token>` |
| API base | `api.github.com` | `instance/api/v4` | `instance/api/v1` |
| Webhook header | `X-GitHub-Event` | `X-Gitlab-Event` | `X-GitHub-Event` (compat) |

**Forgejo note:** Forgejo's API is intentionally GitHub-compatible. We can reuse the GitHub implementation with a custom `baseUrl` and `token` auth prefix. Forgejo even sends GitHub-compatible webhook headers.

### Directory Structure

```
src/controller/forge/
├── index.js             # ForgeClient base class + factory function
├── github.js            # GitHub implementation (Octokit)
├── gitlab.js            # GitLab implementation (Gitbeaker)
└── forgejo.js           # Forgejo (extends GitHub client with auth tweak)
```

### Factory

```javascript
// src/controller/forge/index.js

export function createForgeClient(project) {
  switch (project.forge_type) {
    case 'github':
      return new GitHubClient(project);
    case 'gitlab':
      return new GitLabClient(project);
    case 'forgejo':
      return new ForgejoClient(project);
    default:
      throw new Error(`Unknown forge type: ${project.forge_type}`);
  }
}
```

## Git Worktrees for Parallel Execution

### Why Worktrees?

Currently every task clones the entire repo. This is slow and disk-heavy. With projects, the Controller can:

1. Clone the repo once as a **bare repository**
2. Create lightweight **worktrees** for each task
3. Multiple runners work on different branches simultaneously
4. Worktrees share the git object store — disk-efficient

### Bare Repo Cache

```
/data/repos/                                 # Persistent volume
├── my-api.git/                              # Bare clone (git clone --bare)
│   ├── objects/                             # Shared git objects
│   ├── refs/
│   └── worktrees/
│       ├── task_abc123/                     # Worktree metadata
│       └── task_def456/
├── my-frontend.git/
│   └── ...
```

### Worktree Lifecycle

```
POST /tasks {projectId, prompt}
  │
  ├─ Controller: git fetch origin (update bare repo)
  │
  ├─ Controller: git worktree add
  │     /data/repos/my-api.git/worktrees/task_abc123
  │     -b claude/task_abc123
  │     origin/main
  │
  ├─ Controller: create Runner container with bind mount:
  │     /data/repos/my-api.git/worktrees/task_abc123:/workspace:rw
  │
  ├─ Runner: works directly in /workspace (no orchestrator phase)
  │     - Branch already checked out
  │     - All git history available
  │     - Can push to origin
  │
  ├─ Runner: task completes → stream closes
  │
  └─ Controller: git worktree remove
        /data/repos/my-api.git/worktrees/task_abc123
```

### Worktree Manager (`src/controller/project-manager.js`)

```javascript
export class ProjectManager {
  constructor(db, reposDir) {
    this.db = db;                          // better-sqlite3 instance
    this.reposDir = reposDir;              // /data/repos
  }

  // Register a new project
  async register(project) {
    // 1. Validate forge connection (can we list issues?)
    // 2. Clone bare repo: git clone --bare <url> /data/repos/<name>.git
    // 3. Insert into projects table
  }

  // Create a worktree for a task
  async createWorktree(projectId, taskId) {
    const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    const barePath = project.local_bare_path;

    // Fetch latest from origin
    await exec(`git -C ${barePath} fetch origin`);

    // Create worktree on a new branch from default branch
    const branchName = `claude/${taskId}`;
    const worktreePath = path.join(barePath, 'worktrees', taskId);
    await exec(`git -C ${barePath} worktree add ${worktreePath} -b ${branchName} origin/${project.default_branch}`);

    return { worktreePath, branchName };
  }

  // Remove a worktree after task completes
  async removeWorktree(projectId, taskId) {
    const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    const worktreePath = path.join(project.local_bare_path, 'worktrees', taskId);
    await exec(`git -C ${project.local_bare_path} worktree remove ${worktreePath} --force`);
  }

  // Mount worktree into Runner container
  getWorktreeBindMount(projectId, taskId) {
    const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    const worktreePath = path.join(project.local_bare_path, 'worktrees', taskId);
    return `${worktreePath}:/workspace:rw`;
  }
}
```

### Worktree Constraint

Git enforces: **one branch per worktree**. You cannot check out the same branch in two worktrees. Since each task creates a unique branch (`claude/<task-id>`), this is never a problem.

## How Project Tasks Differ from Ad-Hoc Tasks

| Aspect | Ad-Hoc Task (legacy) | Project Task |
|--------|---------------------|--------------|
| Repo discovery | Orchestrator Claude guesses | Explicit from project registration |
| Clone | Full clone per task | Bare repo + worktree (shared objects) |
| Orchestrator phase | Required (clone, branch, deps) | Skipped (Controller prepares worktree) |
| Branch creation | Orchestrator creates | Controller creates via worktree |
| Runner mount | None (Runner clones internally) | Worktree bind-mounted at `/workspace` |
| Proto field | `project_context` absent | `project_context` present |
| Issue tracking | None | Optional (issue_id on task) |
| PR cross-references | None | "Fixes #42" auto-added |
| Startup time | ~2-5 min (clone + deps) | ~5 sec (worktree + container) |

### Runner Behavior with ProjectContext

When `ExecuteTaskRequest.project_context` is set:

1. Runner skips orchestrator phase entirely
2. Runner's working directory is the pre-mounted worktree at `/workspace`
3. Worker system prompt is augmented with issue context:
   - Issue title and number for commit messages
   - "Fixes #42" instruction for PR body
   - Forge type for correct CLI usage (`gh` vs `glab` vs forge-specific)
4. Worker still does: implement, commit, push, create PR
5. After completion, Controller calls forge API to link PR to issue

## HTTP API: Projects

### `POST /projects` — Register a project

```json
// Request
{
  "name": "my-api",
  "forgeType": "github",
  "cloneUrl": "https://github.com/org/my-api.git",
  "defaultBranch": "main",
  "forgeOwner": "org",
  "forgeRepo": "my-api",
  "forgeBaseUrl": "https://github.com",
  "forgeApiToken": "ghp_..."
}

// Response
{
  "id": "proj_a1b2c3d4",
  "name": "my-api",
  "forgeType": "github",
  "status": "cloning",
  "createdAt": "2026-02-10T12:00:00Z"
}
```

Controller asynchronously: clones bare repo, validates forge connection, syncs issues.

### `GET /projects` — List projects

```json
[
  {
    "id": "proj_a1b2c3d4",
    "name": "my-api",
    "forgeType": "github",
    "defaultBranch": "main",
    "openIssues": 12,
    "activeTasks": 2,
    "lastSyncedAt": "2026-02-10T14:00:00Z"
  }
]
```

### `GET /projects/:id` — Project details

Includes issue counts by type/status, recent tasks, configs.

### `DELETE /projects/:id` — Unregister a project

Removes bare repo cache and all worktrees. Issues and tasks preserved for history.

### `POST /projects/:id/sync` — Sync issues from forge

Imports open issues from the forge. Creates/updates Issue records.

```json
// Response
{
  "imported": 8,
  "updated": 3,
  "closed": 1
}
```

## HTTP API: Issues

### `POST /projects/:projectId/issues` — Create an issue

```json
// Request
{
  "title": "Fix auth token expiry",
  "body": "Tokens expire after 1 hour but aren't refreshed...",
  "type": "bug",
  "priority": "high",
  "labels": ["auth", "bug"],
  "syncToForge": true
}

// Response
{
  "id": "iss_e5f6g7h8",
  "projectId": "proj_a1b2c3d4",
  "title": "Fix auth token expiry",
  "type": "bug",
  "status": "open",
  "forgeNumber": 42,
  "forgeUrl": "https://github.com/org/my-api/issues/42"
}
```

If `syncToForge: true`, the Controller also creates the issue on the forge via API.

### `GET /projects/:projectId/issues` — List issues

Query params: `?status=open`, `?type=bug`, `?priority=high`

### `GET /issues/:id` — Issue details

Includes all associated tasks with their statuses.

### `PATCH /issues/:id` — Update issue

### `POST /issues/:id/tasks` — Create a task for an issue

```json
// Request
{
  "prompt": "Fix the token refresh logic in src/auth.ts"
}

// Response
{
  "id": "task_i9j0k1l2",
  "projectId": "proj_a1b2c3d4",
  "issueId": "iss_e5f6g7h8",
  "status": "queued",
  "branchName": "claude/task_i9j0k1l2"
}
```

This is the primary way to dispatch work. The Controller:
1. Creates the task record
2. Creates a worktree from the project's bare repo
3. Routes to a runner (per existing TaskRouter logic)
4. Sends `ExecuteTaskRequest` with `project_context` including issue info
5. Runner creates a PR that references the issue

## Updated Task Flow (Project Mode)

```
POST /issues/:id/tasks {prompt}
  │
  ├─ Controller: create task record in SQLite
  │    {project_id, issue_id, status: 'queued'}
  │
  ├─ Controller: projectManager.createWorktree(projectId, taskId)
  │    → git fetch origin
  │    → git worktree add .../worktrees/task_abc -b claude/task_abc origin/main
  │
  ├─ Controller: taskRouter.route(taskId)
  │    → find or create runner
  │
  ├─ Controller: create runner container with extra bind mount:
  │    Binds: [..., "/data/repos/my-api.git/worktrees/task_abc:/workspace:rw"]
  │
  ├─ Controller: runner.grpcClient.ExecuteTask({
  │    task_id, prompt, config_files,
  │    project_context: {
  │      project_id: "proj_a1b2c3d4",
  │      repo_name: "my-api",
  │      branch_name: "claude/task_abc",
  │      default_branch: "main",
  │      forge_type: "github",
  │      issue_number: "42",
  │      issue_title: "Fix auth token expiry",
  │      issue_url: "https://github.com/org/my-api/issues/42"
  │    }
  │  })
  │
  ├─ Runner: (NO orchestrator phase)
  │    → cwd = /workspace (mounted worktree)
  │    → worker phase only
  │    → commits reference "Fixes #42"
  │    → creates PR with issue link
  │    → streams logs, artifacts, result
  │
  ├─ Controller: receives RESULT
  │    → updates task in SQLite (status, pr_url)
  │    → updates issue status to "in_progress"
  │    → forge.addIssueComment(42, "Claude created PR: <url>")
  │
  └─ Controller: projectManager.removeWorktree(projectId, taskId)
```

## Issue Lifecycle

```
  ┌────────┐     task created     ┌─────────────┐
  │  open  ├─────────────────────►│ in_progress  │
  └────┬───┘                      └──────┬───────┘
       │                                 │
       │  manually closed                │  all tasks completed
       │                                 │  (at least one successful)
       ▼                                 ▼
  ┌────────┐                      ┌──────────┐
  │ closed │                      │ resolved │
  └────────┘                      └──────┬───┘
                                         │
                                         │  PR merged on forge
                                         ▼
                                    ┌────────┐
                                    │ closed │
                                    └────────┘
```

State transitions:
- `open` → `in_progress`: When first task is created for the issue
- `in_progress` → `resolved`: When a task completes successfully (PR created)
- `resolved` → `closed`: When the PR is merged (detected via webhook or sync)
- Any → `closed`: Manual close via API

## Configs Become Project-Scoped

The existing config store gains a `project_id` column. Configs can be:

- **Global** (`project_id = NULL`): Apply to all tasks
- **Project-scoped** (`project_id = 'proj_...'`): Apply only to tasks in that project

Config resolution order for a task:
1. Global configs (default set)
2. Project-specific configs (override/extend globals)
3. `configIds` from the task request (if provided, replaces 1+2)
4. `extraConfigs` from the task request (always merged last)

This means a project can have its own rules, skills, and MCP configs that are automatically deployed to every task in that project.

## Updated Directory Structure

```
src/controller/
├── server.js                # Express app, auth, all route mounting
├── runner-pool.js           # Runner lifecycle (unchanged)
├── task-router.js           # Task → Runner routing (unchanged)
├── config-store.js          # Config CRUD (adds project_id support)
├── project-manager.js       # NEW: Project CRUD, bare repo cache, worktree lifecycle
├── issue-manager.js         # NEW: Issue CRUD, status transitions
├── db.js                    # NEW: SQLite setup, migrations, prepared statements
├── forge/                   # NEW: Forge abstraction
│   ├── index.js             #   Base class + factory
│   ├── github.js            #   GitHub (Octokit)
│   ├── gitlab.js            #   GitLab (Gitbeaker)
│   └── forgejo.js           #   Forgejo (Octokit + auth tweak)
└── static/
    ├── dashboard.html
    ├── login.html
    └── setup.html
```

## New Dependencies

```json
{
  "better-sqlite3": "^11.0.0",
  "@octokit/rest": "^21.0.0",
  "@gitbeaker/rest": "^40.0.0"
}
```

- `better-sqlite3` — Embedded persistence for projects, issues, tasks
- `@octokit/rest` — GitHub + Forgejo API client
- `@gitbeaker/rest` — GitLab API client

These are Controller-only dependencies. The Runner is unchanged.

## Updated Migration Path

Insert these steps after step 8 (artifact HTTP API) and before step 9 (RunnerPool):

**8a. Add SQLite persistence** — `src/controller/db.js`. Migrate in-memory task `Map` to SQLite. Both reads and writes go through `db`. Tasks still work the same, just persisted.

**8b. Add Project Manager** — `src/controller/project-manager.js`. `POST/GET/DELETE /projects`. Bare repo cloning, worktree lifecycle.

**8c. Add Forge abstraction** — `src/controller/forge/`. Start with GitHub only. Issue sync, PR creation, comments.

**8d. Add Issue Manager** — `src/controller/issue-manager.js`. `POST/GET/PATCH /projects/:id/issues`, `POST /issues/:id/tasks`. Issue lifecycle.

**8e. Add project_context to task dispatch** — When a task has a `project_id`, Controller creates worktree, mounts it into Runner, sends `ProjectContext` in proto. Runner skips orchestrator.

**8f. Add GitLab + Forgejo forge implementations** — Extend forge layer.

## Known Challenges

**13. Bare repo disk usage** — Each project's bare repo cache grows with git history. For large repos (>1GB), this may be significant. Implement periodic `git gc` and consider shallow clones for very large repos (`git clone --bare --depth=100`).

**14. Worktree cleanup on crash** — If the Controller crashes mid-task, worktrees are left behind. On startup, scan for orphaned worktrees (no matching active task) and prune them with `git worktree prune`.

**15. Forge API rate limits** — GitHub allows 5000 requests/hour for authenticated users. Issue sync for repos with hundreds of issues could hit limits. Implement pagination and conditional requests (`If-None-Match` / ETags).

**16. Webhook delivery** — Webhooks require the Controller to be reachable from the forge. For self-hosted setups this is easy; for SaaS GitHub/GitLab the Controller needs a public URL or a tunnel. Webhook support is optional — polling via `/projects/:id/sync` works as fallback.

**17. Forge token scoping** — A single `GITHUB_TOKEN` may not have access to all projects. Support per-project tokens (`forge_api_token` in the projects table) with fallback to the global token.

**18. SQLite migration strategy** — Schema changes need migrations. Use a simple version table: `CREATE TABLE schema_version (version INTEGER)`. Check on startup, run migration scripts sequentially. No ORM — raw SQL with prepared statements.

**19. Worktree + Runner mount timing** — The worktree must be created before the Runner container starts (it's a bind mount). If worktree creation fails (disk full, git error), the task should fail immediately with `error_type: 'worktree_error'` rather than dispatching to a runner.

**20. Concurrent fetches on same bare repo** — If two tasks for the same project start simultaneously, both try to `git fetch origin`. This is safe (git handles concurrent fetches), but may be slow. Consider a per-project fetch lock or a background fetch scheduler.
