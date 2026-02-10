# UI Design: Dashboard, Kanban, Issues, Projects

This document defines the frontend UI for the Controller. Extends the [architecture plan](./architecture-plan.md) and [projects-and-issues](./projects-and-issues.md) design.

## Design Principles

- **Vanilla JS** — No framework, no build step. Single-file SPA with hash routing. Matches the existing `dashboard.html` pattern.
- **Dark theme** — GitHub-dark style already in use. All new views follow the same palette.
- **Auto-refresh** — Views poll their data on intervals (5s for tasks/board, 15s for issues/projects). Live data without WebSockets.
- **Progressive** — Works without projects/issues. The one-off task flow remains the default landing experience.

## Navigation

Top-level tab bar replacing the current header. Four views:

```
┌──────────────────────────────────────────────────────────────────┐
│  Claude Runner    [Tasks]  [Board]  [Projects]  [Issues]  user ▾│
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│                     (active view content)                         │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

- Hash routing: `#tasks` (default), `#board`, `#projects`, `#issues`
- Active tab highlighted with bottom border accent (`#58a6ff`)
- User menu (top-right): username, Sign Out
- All views share the same auth headers and token management

## File Structure

```
src/controller/static/
├── index.html              # SPA shell: nav, auth, router, shared styles
├── views/
│   ├── tasks.js            # Tasks view (current dashboard, refactored)
│   ├── board.js            # Kanban board
│   ├── projects.js         # Project management
│   └── issues.js           # Issue list + detail
├── components/
│   ├── task-card.js        # Shared task card (used in board + task detail)
│   ├── log-viewer.js       # Log modal (extracted from current dashboard)
│   └── forms.js            # Shared form helpers (modal forms, validation)
└── app.css                 # All styles (extracted from inline <style>)
```

Each view JS file exports `{ mount(container), unmount(), refresh() }`. The router calls `mount` when navigating and `unmount` when leaving.

## View 1: Tasks (refactored current dashboard)

**Route:** `#tasks` (default)

Keeps the existing functionality intact. Minor layout changes:

```
┌─────────────────────────────────────────────────────────────┐
│  Stats Bar                                                   │
│  [Running: 2]  [Completed: 15]  [Failed: 1]  [Runners: 3]  │
├─────────────────────────────────────────────────────────────┤
│  Submit New Task                                             │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ [textarea: prompt]                                       ││
│  │                                                          ││
│  │ Project: [-- None (ad-hoc) --  ▾]  (optional dropdown)  ││
│  │ Issue:   [-- None --  ▾]           (filtered by project) ││
│  │                                                          ││
│  │ [Submit Task]                                            ││
│  └─────────────────────────────────────────────────────────┘│
├─────────────────────────────────────────────────────────────┤
│  Recent Tasks                                                │
│  ┌──────┬──────────┬─────────┬──────────┬─────┬──────┐     │
│  │ ID   │ Prompt   │ Project │ Status   │ PR  │ Logs │     │
│  ├──────┼──────────┼─────────┼──────────┼─────┼──────┤     │
│  │ t_a1 │ Fix auth │ my-api  │ running  │ -   │ View │     │
│  │ t_b2 │ Add dark │ (ad-hoc)│completed │ #12 │ View │     │
│  └──────┴──────────┴─────────┴──────────┴─────┴──────┘     │
└─────────────────────────────────────────────────────────────┘
```

**Changes from current dashboard:**
- Stats bar gains a "Runners" count
- Task submission form gains optional Project and Issue dropdowns
- Task table gains a "Project" column
- API token section moves to a Settings modal (accessible from user menu)
- Log modal is unchanged

**API calls:**
- `GET /tasks` — task list (5s refresh)
- `GET /projects` — populate project dropdown
- `GET /projects/:id/issues?status=open` — populate issue dropdown (when project selected)
- `POST /task` — submit (now with optional `projectId`, `issueId`)
- `GET /task/:id/logs` — log viewer

## View 2: Board (Kanban)

**Route:** `#board`

Visual task board with columns for each status. Optimized for monitoring active work.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Filters: Project [All ▾]  Runner [All ▾]           [+ New Task]   │
├────────────────┬────────────────┬─────────────────┬─────────────────┤
│    QUEUED (3)  │  RUNNING (2)   │ COMPLETED (12)  │   FAILED (1)   │
├────────────────┼────────────────┼─────────────────┼─────────────────┤
│ ┌────────────┐ │ ┌────────────┐ │ ┌─────────────┐ │ ┌────────────┐ │
│ │ Fix auth   │ │ │ Add dark   │ │ │ Refactor DB │ │ │ Update CI  │ │
│ │ my-api#42  │ │ │ my-api     │ │ │ my-api#38   │ │ │ my-api#40  │ │
│ │            │ │ │ runner-a1  │ │ │ PR #156     │ │ │ exit_code  │ │
│ │ 2m ago     │ │ │ 15m ⏱     │ │ │ 45m         │ │ │ 12m        │ │
│ │ [Logs]     │ │ │ [Logs]     │ │ │ [PR] [Logs] │ │ │ [Logs]     │ │
│ └────────────┘ │ └────────────┘ │ └─────────────┘ │ └────────────┘ │
│ ┌────────────┐ │ ┌────────────┐ │ ┌─────────────┐ │                │
│ │ Add tests  │ │ │ Fix i18n   │ │ │ Add auth    │ │                │
│ │ frontend   │ │ │ frontend#7 │ │ │ PR #155     │ │                │
│ │            │ │ │ runner-b2  │ │ │ 30m         │ │                │
│ │ 5m ago     │ │ │ 8m ⏱      │ │ │ [PR] [Logs] │ │                │
│ │ [Logs]     │ │ │ [Logs]     │ │ └─────────────┘ │                │
│ └────────────┘ │ └────────────┘ │       ...       │                │
│ ┌────────────┐ │                │                  │                │
│ │ Dep update │ │                │                  │                │
│ │ backend#15 │ │                │                  │                │
│ │            │ │                │                  │                │
│ │ just now   │ │                │                  │                │
│ │ [Logs]     │ │                │                  │                │
│ └────────────┘ │                │                  │                │
└────────────────┴────────────────┴─────────────────┴─────────────────┘
```

### Task Card

Each card shows:

```
┌─────────────────────────┐
│ Fix auth token refresh  │  ← prompt (truncated to ~40 chars)
│ my-api #42              │  ← project name + issue number (if any)
│ runner-a1b2  15m ⏱      │  ← runner ID + elapsed time (running only)
│ PR #156                 │  ← PR link (completed only)
│ exit_code               │  ← error type (failed only)
│ [Cancel] [Logs]         │  ← action buttons
└─────────────────────────┘
```

Card border color matches status:
- Queued: `#58a6ff` (blue)
- Running: `#f0883e` (orange) + subtle pulse animation
- Completed: `#3fb950` (green)
- Failed: `#f85149` (red)

### Board Interactions

- **Filter by project**: Dropdown filters cards to a single project (or "All")
- **Filter by runner**: Dropdown filters to tasks on a specific runner
- **[+ New Task]**: Opens same task creation form as Tasks view (modal version)
- **[Cancel]**: Calls `POST /task/:id/cancel` (queued/running tasks only)
- **[Logs]**: Opens log modal (same as Tasks view)
- **[PR]**: Opens PR URL in new tab
- **Cards are NOT draggable** — Task status is controlled by the Runner, not the user. The board is for visualization, not manual workflow management.
- **Completed/Failed columns**: Show most recent 20 tasks, with a "Show more" link that scrolls/paginates. Prevents the board from getting unwieldy.

### Board Layout

- Columns use CSS grid: `grid-template-columns: repeat(4, 1fr)`
- Each column scrolls independently (sticky headers)
- Cards are vertically stacked with `8px` gap
- Responsive: at `< 900px` width, columns stack vertically (mobile-friendly)

**API calls:**
- `GET /tasks` — all tasks (5s refresh)
- `GET /projects` — for filter dropdown
- `GET /runners` — for filter dropdown + runner ID display
- `POST /task` — new task (from modal)
- `POST /task/:id/cancel` — cancel task

## View 3: Projects

**Route:** `#projects`

Project registration and management. Entry point to issue sync.

```
┌─────────────────────────────────────────────────────────────────┐
│  Projects                                          [+ Register] │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  my-api                                         github     │ │
│  │  github.com/org/my-api                                     │ │
│  │                                                            │ │
│  │  Issues: 12 open  ·  Tasks: 3 active  ·  Last sync: 5m    │ │
│  │                                                            │ │
│  │  [View Issues]  [Sync Issues]  [Settings]  [Remove]        │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  my-frontend                                    forgejo    │ │
│  │  git.example.com/org/my-frontend                           │ │
│  │                                                            │ │
│  │  Issues: 5 open  ·  Tasks: 0 active  ·  Last sync: 1h     │ │
│  │                                                            │ │
│  │  [View Issues]  [Sync Issues]  [Settings]  [Remove]        │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  backend-services                               gitlab     │ │
│  │  gitlab.com/org/backend-services                           │ │
│  │                                                            │ │
│  │  Issues: 28 open  ·  Tasks: 1 active  ·  Last sync: 20m   │ │
│  │                                                            │ │
│  │  [View Issues]  [Sync Issues]  [Settings]  [Remove]        │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Register Project Modal

```
┌──────────────────────────────────────────────────────┐
│  Register Project                              [X]   │
├──────────────────────────────────────────────────────┤
│                                                      │
│  Repository URL *                                    │
│  [https://github.com/org/my-api.git            ]    │
│  (Auto-detects forge type from URL)                  │
│                                                      │
│  Forge Type       Name                               │
│  [GitHub     ▾]   [my-api                      ]    │
│  (auto-filled)    (auto-filled from URL)             │
│                                                      │
│  Default Branch                                      │
│  [main                                         ]    │
│                                                      │
│  API Token (optional — falls back to global token)   │
│  [ghp_...                                      ]    │
│                                                      │
│  [ ] Sync issues immediately after registration      │
│                                                      │
│                                    [Cancel] [Register]│
└──────────────────────────────────────────────────────┘
```

**Auto-detection logic** (client-side):
- URL contains `github.com` → forge type = `github`
- URL contains `gitlab.com` or `/api/v4` → forge type = `gitlab`
- Otherwise → forge type = `forgejo` (self-hosted default)
- Extract owner/repo from URL path segments

### Project Settings Modal

Allows editing:
- Name, default branch
- API token (project-scoped override)
- Configs attached to this project (links to config management)

### Interactions

- **[View Issues]**: Navigates to `#issues?project=<id>`
- **[Sync Issues]**: Calls `POST /projects/:id/sync`, shows toast with imported/updated counts
- **[Settings]**: Opens settings modal
- **[Remove]**: Confirm dialog → `DELETE /projects/:id`
- **Forge badge**: Color-coded label (GitHub=gray, GitLab=orange, Forgejo=green)

**API calls:**
- `GET /projects` — project list (15s refresh)
- `POST /projects` — register new project
- `DELETE /projects/:id` — remove project
- `POST /projects/:id/sync` — trigger issue sync
- `PATCH /projects/:id` — update settings

## View 4: Issues

**Route:** `#issues` or `#issues?project=<id>`

Issue management with filters. Primary place to create tasks from issues.

```
┌───────────────────────────────────────────────────────────────────────┐
│  Issues                                                               │
│                                                                       │
│  Project: [my-api          ▾]  Status: [All    ▾]  Type: [All    ▾] │
│  Priority: [All  ▾]  Source: [All ▾]                [+ New Issue]    │
├───────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  #42  Fix auth token refresh                        bug  high  │ │
│  │  ● in_progress · synced from GitHub · 2 tasks                  │ │
│  │                                                                 │ │
│  │  Tokens expire after 1 hour but aren't refreshed. Users get    │ │
│  │  logged out mid-session...                                     │ │
│  │                                                                 │ │
│  │  Tasks:                                                        │ │
│  │  ├─ task_a1b2 "Plan auth refactor"      completed  PR #155     │ │
│  │  └─ task_c3d4 "Implement token refresh" running    15m ⏱       │ │
│  │                                                                 │ │
│  │  [+ Create Task]  [Sync]  [Close]  [View on GitHub ↗]         │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  #38  Refactor database connection pooling        feature  med │ │
│  │  ● resolved · synced from GitHub · 1 task                      │ │
│  │                                                                 │ │
│  │  Tasks:                                                        │ │
│  │  └─ task_e5f6 "Implement connection pool" completed  PR #156   │ │
│  │                                                                 │ │
│  │  [+ Create Task]  [Sync]  [Reopen]  [View on GitHub ↗]        │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  #15  Update lodash to v5                     dependency  low  │ │
│  │  ● open · synced from GitHub · 0 tasks                         │ │
│  │                                                                 │ │
│  │  [+ Create Task]  [View on GitHub ↗]                           │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│  Showing 3 of 12 issues                            [Load more]       │
└───────────────────────────────────────────────────────────────────────┘
```

### Issue Card (Expanded)

Each issue is a collapsible card. Collapsed shows one line; expanded shows body + tasks.

**Collapsed:**
```
┌─────────────────────────────────────────────────────────────┐
│ ▸ #42  Fix auth token refresh     ● in_progress  bug  high │
│   2 tasks · last activity 15m ago                           │
└─────────────────────────────────────────────────────────────┘
```

**Expanded** (click to toggle):
Shows issue body, task list, and action buttons as in the full layout above.

### Status Indicators

- `open` — Blue dot (`#58a6ff`)
- `in_progress` — Orange dot (`#f0883e`) + pulsing
- `resolved` — Green dot (`#3fb950`)
- `closed` — Gray dot (`#8b949e`)

### Type Badges

- `bug` — Red badge
- `feature` — Purple badge
- `dependency` — Yellow badge
- `chore` — Gray badge

### Priority Badges

- `critical` — Red, bold
- `high` — Orange
- `medium` — (no badge, default)
- `low` — Gray, muted

### Source Indicator

Each issue shows whether it was:
- **Synced from forge** — "synced from GitHub" with forge icon
- **Created locally** — "created locally" (no forge number yet)
- **Synced + local changes** — "modified locally" (edited after sync)

### Create Task from Issue

Clicking **[+ Create Task]** on an issue opens a modal:

```
┌──────────────────────────────────────────────────────┐
│  Create Task for #42                           [X]   │
├──────────────────────────────────────────────────────┤
│                                                      │
│  Issue: Fix auth token refresh                       │
│  Project: my-api                                     │
│                                                      │
│  Task Prompt *                                       │
│  ┌────────────────────────────────────────────────┐ │
│  │ Fix the token refresh logic in src/auth.ts.    │ │
│  │ Tokens should auto-refresh 5 minutes before    │ │
│  │ expiry...                                      │ │
│  └────────────────────────────────────────────────┘ │
│  (Pre-filled with issue title. User can customize.) │
│                                                      │
│                              [Cancel] [Create Task]  │
└──────────────────────────────────────────────────────┘
```

The prompt textarea is pre-filled with the issue title + body (truncated). The user can edit before dispatching.

### Create Issue Modal

```
┌──────────────────────────────────────────────────────┐
│  New Issue                                     [X]   │
├──────────────────────────────────────────────────────┤
│                                                      │
│  Project *                                           │
│  [my-api          ▾]                                 │
│                                                      │
│  Title *                                             │
│  [                                             ]    │
│                                                      │
│  Description                                         │
│  ┌────────────────────────────────────────────────┐ │
│  │                                                │ │
│  └────────────────────────────────────────────────┘ │
│                                                      │
│  Type            Priority                            │
│  [feature    ▾]  [medium   ▾]                       │
│                                                      │
│  Labels (comma-separated)                            │
│  [auth, backend                                ]    │
│                                                      │
│  [ ] Also create on forge (GitHub/GitLab/Forgejo)    │
│  [ ] Immediately create a task for this issue        │
│                                                      │
│                               [Cancel] [Create]      │
└──────────────────────────────────────────────────────┘
```

### Filters

All filters are URL-param driven (`#issues?project=proj_a1&status=open&type=bug`):

| Filter | Options | Default |
|--------|---------|---------|
| Project | All registered projects | Required (if >1 project) |
| Status | All, Open, In Progress, Resolved, Closed | All |
| Type | All, Bug, Feature, Dependency, Chore | All |
| Priority | All, Critical, High, Medium, Low | All |
| Source | All, Synced, Local | All |

Changing a filter updates the URL and re-fetches.

**API calls:**
- `GET /projects` — project dropdown
- `GET /projects/:id/issues?status=&type=&priority=` — issue list (15s refresh)
- `GET /issues/:id` — issue detail with tasks
- `POST /projects/:id/issues` — create issue
- `PATCH /issues/:id` — update issue (close, reopen, change priority)
- `POST /issues/:id/tasks` — create task for issue
- `POST /projects/:id/sync` — sync issues from forge

## Shared Components

### Log Viewer Modal

Extracted from the current `dashboard.html`. Same behavior:
- Full-screen overlay
- Auto-refresh (2s)
- Formatted log entries (system, assistant, tool result, phase, raw)
- Auto-scroll to bottom (unless user is selecting text)

Used by both Tasks view and Board view.

### Toast Notifications

Lightweight notification system for action feedback:

```
┌──────────────────────────────────┐
│  ✓ Task created: task_a1b2c3     │  ← success (green, auto-dismiss 3s)
└──────────────────────────────────┘

┌──────────────────────────────────┐
│  ✓ Synced: 8 imported, 3 updated │  ← info (blue, auto-dismiss 5s)
└──────────────────────────────────┘

┌──────────────────────────────────┐
│  ✗ Failed to register project    │  ← error (red, click to dismiss)
└──────────────────────────────────┘
```

Position: bottom-right, stacked vertically.

### Form Modals

Shared modal pattern:
- Dark overlay (`rgba(0,0,0,0.8)`)
- Centered card (`max-width: 540px`)
- Close on Escape or X button
- Submit on Enter (in single-line fields)
- Loading state on submit button
- Error display below form

## CSS Design Tokens

Extending the existing dashboard palette:

```css
:root {
  /* Existing (from dashboard.html) */
  --bg-primary: #0d1117;
  --bg-secondary: #161b22;
  --bg-tertiary: #21262d;
  --border: #30363d;
  --text-primary: #c9d1d9;
  --text-secondary: #8b949e;
  --accent-blue: #58a6ff;
  --accent-green: #3fb950;
  --accent-orange: #f0883e;
  --accent-red: #f85149;
  --accent-purple: #a855f7;

  /* New */
  --accent-yellow: #d29922;
  --accent-green-bg: #3fb95022;
  --accent-orange-bg: #f0883e22;
  --accent-red-bg: #f8514922;
  --accent-blue-bg: #58a6ff22;
  --accent-purple-bg: #a855f722;
  --accent-yellow-bg: #d2992222;

  /* Kanban */
  --card-radius: 8px;
  --column-gap: 16px;
  --card-gap: 8px;

  /* Nav */
  --nav-height: 48px;
}
```

## Router Implementation

Simple hash router — no dependencies:

```javascript
const routes = {
  tasks:    { mount: mountTasks,    unmount: unmountTasks    },
  board:    { mount: mountBoard,    unmount: unmountBoard    },
  projects: { mount: mountProjects, unmount: unmountProjects },
  issues:   { mount: mountIssues,   unmount: unmountIssues   },
};

let currentView = null;

function navigate() {
  const hash = location.hash.slice(1) || 'tasks';
  const [view, queryString] = hash.split('?');
  const params = new URLSearchParams(queryString || '');

  if (currentView && routes[currentView]) {
    routes[currentView].unmount();
  }

  const container = document.getElementById('app');
  container.innerHTML = '';
  currentView = view;

  if (routes[view]) {
    routes[view].mount(container, params);
  }
}

window.addEventListener('hashchange', navigate);
navigate(); // initial load
```

## API Summary

New/changed endpoints the UI depends on:

| Endpoint | View(s) | Purpose |
|----------|---------|---------|
| `GET /tasks` | Tasks, Board | Task list with project/issue references |
| `POST /task` | Tasks, Board | Create task (gains `projectId`, `issueId`) |
| `POST /task/:id/cancel` | Board | Cancel a queued/running task |
| `GET /task/:id/logs` | Tasks, Board | Log content for viewer |
| `GET /projects` | Projects, Tasks, Issues | Project list |
| `POST /projects` | Projects | Register project |
| `DELETE /projects/:id` | Projects | Remove project |
| `PATCH /projects/:id` | Projects | Update project settings |
| `POST /projects/:id/sync` | Projects, Issues | Sync issues from forge |
| `GET /projects/:id/issues` | Issues | Issue list (with filters) |
| `GET /issues/:id` | Issues | Issue detail with tasks |
| `POST /projects/:id/issues` | Issues | Create issue |
| `PATCH /issues/:id` | Issues | Update issue |
| `POST /issues/:id/tasks` | Issues | Create task for issue |
| `GET /runners` | Board | Runner list for filter |

### Updated `GET /tasks` Response

Tasks now include project and issue context:

```json
[
  {
    "id": "task_a1b2",
    "prompt": "Fix auth token refresh",
    "status": "running",
    "runnerId": "runner-abc",
    "projectId": "proj_x1",
    "projectName": "my-api",
    "issueId": "iss_y2",
    "issueNumber": 42,
    "issueTitle": "Fix auth token expiry",
    "prUrl": null,
    "branchName": "claude/task_a1b2",
    "error": null,
    "errorType": null,
    "startedAt": "2026-02-10T14:00:00Z",
    "createdAt": "2026-02-10T13:59:55Z"
  }
]
```

### Updated `POST /task` Request

```json
{
  "prompt": "Fix the token refresh logic",
  "projectId": "proj_x1",
  "issueId": "iss_y2",
  "runnerId": "runner-abc"
}
```

All three optional fields (`projectId`, `issueId`, `runnerId`) are nullable. Omitting them gives the existing ad-hoc behavior.

## Responsive Behavior

| Breakpoint | Layout Changes |
|------------|----------------|
| `> 1200px` | Full layout as designed |
| `900-1200px` | Kanban columns shrink, card text truncates more aggressively |
| `< 900px` | Kanban columns stack vertically. Nav collapses to hamburger menu. Issue cards use full width. |

## Migration from Current dashboard.html

1. **Extract styles** from `dashboard.html` inline `<style>` into `app.css`
2. **Extract log viewer** into `components/log-viewer.js`
3. **Refactor task list + stats** into `views/tasks.js`
4. **Replace `dashboard.html`** with `index.html` (SPA shell)
5. **Add new views** incrementally: Board → Projects → Issues
6. The current `login.html` and `setup.html` remain separate pages (pre-auth, no SPA routing needed)

## Settings (from User Menu)

API token management moves out of the main Tasks view into a settings dropdown/modal:

```
User ▾
├─ Settings
│  ├─ API Token (generate, revoke, paste)
│  └─ Preferences (future: theme, refresh intervals)
└─ Sign Out
```

This declutters the Tasks view while keeping token management accessible.
