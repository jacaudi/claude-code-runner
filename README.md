# Claude Code Runner

[![Docker Pulls](https://img.shields.io/docker/pulls/ericvtheg/claude-code-runner)](https://hub.docker.com/r/ericvtheg/claude-code-runner)
[![Docker Image Size](https://img.shields.io/docker/image-size/ericvtheg/claude-code-runner/latest)](https://hub.docker.com/r/ericvtheg/claude-code-runner)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Self-hosted service that accepts coding task prompts via HTTP and spawns Claude Code instances to autonomously implement them. Uses your Claude Code subscription (no API key required).

## Features

- **Fire and forget** - Submit a prompt, get a PR
- **Two-phase architecture** - Orchestrator finds repo, Worker implements changes
- **Web dashboard** - Submit tasks and monitor progress in real-time
- **Dual deployment** - Run locally with Docker or scale with Kubernetes

## Quick Start

```bash
# Authenticate Claude Code on your host first
claude

# Then run the container
docker pull ericvtheg/claude-code-runner:latest
```

```yaml
# docker-compose.yml
services:
  claude-runner:
    image: ericvtheg/claude-code-runner:latest
    ports:
      - "7334:3000"
    environment:
      - GITHUB_TOKEN=${GITHUB_TOKEN}
    volumes:
      - ~/.claude/.credentials.json:/home/node/.claude/.credentials.json:ro
      - claude-data:/data

volumes:
  claude-data:
```

Navigate to `http://localhost:7334` to set up your account and start submitting tasks.

## How It Works

1. **Submit** a natural language prompt via dashboard or API
2. **Orchestrator** identifies the repo and clones it
3. **Worker** implements changes, commits, and opens a PR
4. **Monitor** progress through the dashboard or API

## API Usage

```bash
# Generate an API token from the dashboard, then:
curl -X POST http://localhost:7334/task \
  -H "Authorization: Bearer ccr_your_token" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "In acme-api repo, fix the auth bug in login.js"}'

# Check status
curl -H "Authorization: Bearer ccr_your_token" http://localhost:7334/task/<id>
```

## Screenshots

![Dashboard](docs/dashboard.png)
![Logs View](docs/logs-view.png)

## Requirements

- Docker
- `GITHUB_TOKEN` with repo scope
- Claude Code authenticated on host (`~/.claude/.credentials.json`)

## Deployment Options

| Mode | Command | Storage |
|------|---------|---------|
| Docker (local) | `docker compose up` | In-memory |
| Docker + Postgres | `docker compose -f docker-compose.dev.yml up` | Persistent |
| Kubernetes | See [K8s Guide](docs/architecture.md#kubernetes-deployment) | Persistent |

## Documentation

| Guide | Description |
|-------|-------------|
| [Architecture](docs/architecture.md) | System design, components, data flow |
| [API Reference](docs/architecture.md#api-reference) | Complete endpoint documentation |
| [K8s Deployment](docs/architecture.md#kubernetes-deployment) | Kubernetes setup guide |
| [Configuration](docs/architecture.md#environment-variables) | Environment variables |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_TOKEN` | Yes | GitHub PAT with repo scope |
| `PORT` | No | Server port (default: 3000) |
| `SESSION_SECRET` | No | Session secret for consistent sessions |
| `DATABASE_URL` | No | PostgreSQL URL for persistent storage |

## Security

- Authentication required for all API/dashboard access
- First visit prompts account creation
- API tokens for programmatic access (`ccr_` prefix)
- **Recommended:** Run behind VPN or private network

## License

MIT
