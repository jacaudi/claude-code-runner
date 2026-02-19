#!/bin/bash
#
# Git wrapper for branch protection inside task containers.
#
# Prevents Claude from switching to existing branches (e.g. main, master),
# which would escape the task's sandbox branch. Only allows:
#   - Creating new branches: git checkout -b <name>, git switch -c <name>
#   - All other git commands pass through unchanged
#
# The sentinel file /tmp/.branch-created tracks whether the initial task
# branch has been set up. Before it exists, all operations are allowed
# (the orchestrator needs to create and checkout the branch freely).

SENTINEL="/tmp/.branch-created"

# Before the task branch is created, allow everything
if [ ! -f "$SENTINEL" ]; then
    # Track the first branch creation
    if [ "$1" = "checkout" ] && [ "$2" = "-b" ]; then
        touch "$SENTINEL"
    elif [ "$1" = "switch" ] && [ "$2" = "-c" ]; then
        touch "$SENTINEL"
    fi
    exec /usr/bin/git.real "$@"
fi

# After branch creation, block switching to existing branches
case "$1" in
    checkout)
        # Allow: git checkout -b <new-branch>
        # Block: git checkout <existing-branch>
        if [ "$2" = "-b" ] || [ "$2" = "-B" ]; then
            exec /usr/bin/git.real "$@"
        fi
        # Allow: git checkout -- <file> (restoring files, not switching branches)
        if [ "$2" = "--" ]; then
            exec /usr/bin/git.real "$@"
        fi
        # Allow: git checkout <file> when it looks like a file path
        # (contains / or . and exists on disk)
        if [[ "$2" == */* ]] || [[ "$2" == *.* ]] || [ -e "$2" ]; then
            exec /usr/bin/git.real "$@"
        fi
        echo "ERROR: Branch switching is blocked in this container." >&2
        echo "You are confined to your task branch for isolation." >&2
        echo "To create a new branch, use: git checkout -b <name>" >&2
        exit 1
        ;;
    switch)
        # Allow: git switch -c <new-branch>
        if [ "$2" = "-c" ] || [ "$2" = "-C" ]; then
            exec /usr/bin/git.real "$@"
        fi
        echo "ERROR: Branch switching is blocked in this container." >&2
        echo "You are confined to your task branch for isolation." >&2
        echo "To create a new branch, use: git switch -c <name>" >&2
        exit 1
        ;;
    *)
        # All other git commands (add, commit, push, pull, diff, etc.) pass through
        exec /usr/bin/git.real "$@"
        ;;
esac
