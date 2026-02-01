#!/bin/sh
set -e

# Configure git identity from environment variables
git config --global user.email "${GIT_USER_EMAIL:-noreply@anthropic.com}"
git config --global user.name "${GIT_USER_NAME:-Claude}"

# Execute the main command
exec "$@"
