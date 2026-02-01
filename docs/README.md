# Documentation

Detailed documentation for Claude Code Runner.

## [Architecture](architecture.md)

Complete technical documentation:

- [Overview](architecture.md#overview) - Deployment modes and flow
- [Two-Phase Architecture](architecture.md#two-phase-architecture) - Orchestrator + Worker
- [System Components](architecture.md#system-components) - Server, dashboard, modules
- [Data Flow](architecture.md#data-flow) - Task lifecycle
- [Authentication](architecture.md#authentication) - Session and token auth
- [Environment Variables](architecture.md#environment-variables) - Configuration
- [API Reference](architecture.md#api-reference) - All endpoints
- [Task States](architecture.md#task-states) - Status flow and errors
- [Kubernetes Deployment](architecture.md#kubernetes-deployment) - K8s setup guide
- [Docker Architecture](architecture.md#docker-architecture) - Container details
- [Worker Constraints](architecture.md#worker-constraints) - Behavioral rules
- [Deployment Recommendations](architecture.md#deployment-recommendations) - Production tips

## Quick Reference

### Deployment

| Mode | Command | Storage |
|------|---------|---------|
| Docker | `docker compose up` | In-memory |
| Docker + Postgres | `docker compose -f docker-compose.dev.yml up` | Persistent |
| Kubernetes | `kubectl apply -f k8s/` | Persistent |

### API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/task` | POST | Submit task |
| `/task/:id` | GET | Task status |
| `/task/:id/logs` | GET | Stream logs |
| `/tasks` | GET | List tasks |
| `/health` | GET | Health check |

### Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_TOKEN` | Yes | GitHub PAT |
| `DATABASE_URL` | No | PostgreSQL URL |
| `SESSION_SECRET` | No | Session secret |
