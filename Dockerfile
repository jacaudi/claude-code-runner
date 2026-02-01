FROM node:22.22.0-slim

ARG CLAUDE_CODE_VERSION=2.1.29

# Git identity defaults (can be overridden at runtime)
ENV GIT_USER_EMAIL=noreply@anthropic.com
ENV GIT_USER_NAME=Claude

RUN apt-get update && apt-get install -y \
    git \
    curl \
    wget \
    ssh \
    python3 \
    make \
    g++ \
    jq \
    nano \
    vim \
    less \
    tree \
    unzip \
    zip \
    shellcheck \
    ripgrep \
    fd-find \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s $(which fdfind) /usr/local/bin/fd

# gh CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# yq (YAML processor)
RUN curl -fsSL "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_$(dpkg --print-architecture)" -o /usr/local/bin/yq \
    && chmod +x /usr/local/bin/yq

# glab (GitLab CLI)
RUN curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/permalink/latest/downloads/glab_$(dpkg --print-architecture).deb" -o /tmp/glab.deb \
    && dpkg -i /tmp/glab.deb \
    && rm /tmp/glab.deb

# uv (fast Python package manager)
RUN UV_ARCH=$(dpkg --print-architecture | sed 's/amd64/x86_64/' | sed 's/arm64/aarch64/') \
    && curl -fsSL "https://github.com/astral-sh/uv/releases/latest/download/uv-${UV_ARCH}-unknown-linux-gnu.tar.gz" \
    | tar -xz -C /usr/local/bin --strip-components=1

# Claude Code
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# Create ~/.claude directory for Claude Code credentials and runtime files
# Only .credentials.json is mounted from host; other files stay in container
RUN mkdir -p /home/node/.claude && chown -R node:node /home/node

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src

# Make entrypoint executable
RUN chmod +x src/entrypoint.sh

# Give node user ownership of app
RUN chown -R node:node /app

# Create work directory
RUN mkdir -p /tmp/work && chown -R node:node /tmp/work

# Create data directory for persistent auth storage
RUN mkdir -p /data && chown -R node:node /data

# Allow node user to install global packages (npm, pip, gem, etc.)
# Claude runs as non-root but needs to install tools dynamically.
# In a container, giving write access to /usr/local and /opt is safe.
RUN chown -R node:node /usr/local /opt

# Add user-local bin paths for tools that default to home directory (cargo, go, bun, etc.)
ENV PATH=/home/node/.local/bin:/home/node/.cargo/bin:/home/node/go/bin:/home/node/.bun/bin:$PATH

# Switch to non-root user
USER node

EXPOSE 3000

# Entrypoint configures git identity from env vars, then runs CMD
ENTRYPOINT ["/app/src/entrypoint.sh"]

# Default to controller mode; worker mode uses: node src/worker.js
CMD ["node", "src/server.js"]
