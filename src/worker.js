import { spawn } from 'child_process';

const TASK_ID = process.env.TASK_ID;
const TASK_PROMPT = process.env.TASK_PROMPT;
const BRANCH_NAME = process.env.BRANCH_NAME;
const CONTROLLER_URL = process.env.CONTROLLER_URL;
const TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

async function callback(data) {
  if (!CONTROLLER_URL) {
    console.log('No CONTROLLER_URL, skipping callback:', JSON.stringify(data));
    return;
  }

  try {
    const response = await fetch(`${CONTROLLER_URL}/internal/task/${TASK_ID}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    if (!response.ok) {
      console.error('Callback failed:', response.status, await response.text());
    }
  } catch (err) {
    console.error('Callback error:', err.message);
  }
}

function getSystemPrompt() {
  return `
# Autonomous Worker Mode

You are running autonomously in a Kubernetes pod. No human in the loop.

## Your Task
${TASK_PROMPT}

## Git Setup
Create and push branch: ${BRANCH_NAME}

## Rules
- NEVER use AskUserQuestion - you will hang forever
- NEVER exit without pushing your commits
- Make reasonable assumptions, document them in commits

## Workflow
1. Identify which repository the user is referring to
2. Clone it using: git clone https://x-access-token:$GITHUB_TOKEN@github.com/OWNER/REPO.git repo
3. cd into the repo
4. Create branch: git checkout -b ${BRANCH_NAME}
5. Implement the requested changes
6. Commit and push after each logical chunk
7. Create a PR: gh pr create --title "<summary>" --body "<details>"

## Context Management
Your context window is precious. DO NOT run more than 3-4 search commands yourself.
- Use Task tool with subagent_type=Explore for any codebase exploration
- Use Task tool for self-contained subtasks

## FINAL STEP (MANDATORY)
Before exiting, you MUST:
1. Push all commits
2. Create a PR
3. Output the PR URL on a line by itself

If blocked or failed: still push whatever you have, create PR noting what went wrong.
`.trim();
}

async function run() {
  console.log(`=== Worker starting for task ${TASK_ID} ===`);
  console.log(`Prompt: ${TASK_PROMPT}`);
  console.log(`Branch: ${BRANCH_NAME}`);
  console.log(`Controller: ${CONTROLLER_URL || '(none)'}`);
  console.log('');

  await callback({ status: 'running' });

  const systemPrompt = getSystemPrompt();

  const claude = spawn('claude', [
    '-p', TASK_PROMPT,
    '--system-prompt', systemPrompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions'
  ], {
    env: {
      ...process.env,
      GH_TOKEN: process.env.GITHUB_TOKEN
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';

  claude.stdout.on('data', (data) => {
    const text = data.toString();
    output += text;
    process.stdout.write(text);
  });

  claude.stderr.on('data', (data) => {
    process.stderr.write(data);
  });

  return new Promise((resolve) => {
    claude.on('exit', async (code) => {
      console.log(`\n=== Claude exited with code ${code} ===`);

      // Extract PR URL from output
      const prMatch = output.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
      const prUrl = prMatch?.[0] || null;

      // Extract repo from output
      const repoMatch = output.match(/github\.com\/([^\/\s]+\/[^\/\s]+)/);
      const repository = repoMatch?.[1]?.replace('.git', '') || null;

      if (code === 0) {
        await callback({
          status: 'completed',
          repository,
          branch: BRANCH_NAME,
          pr_url: prUrl
        });
      } else {
        await callback({
          status: 'failed',
          repository,
          branch: BRANCH_NAME,
          pr_url: prUrl,
          error: `Claude exited with code ${code}`,
          error_type: 'exit_code'
        });
      }

      resolve(code);
    });

    claude.on('error', async (err) => {
      console.error('Failed to spawn Claude:', err.message);
      await callback({
        status: 'failed',
        error: err.message,
        error_type: 'spawn_error'
      });
      resolve(1);
    });
  });
}

// Validate required env vars
if (!TASK_ID || !TASK_PROMPT || !BRANCH_NAME) {
  console.error('Missing required environment variables: TASK_ID, TASK_PROMPT, BRANCH_NAME');
  process.exit(1);
}

// Timeout handler
const timeout = setTimeout(async () => {
  console.error('=== Worker timeout reached ===');
  await callback({
    status: 'failed',
    error: 'Worker timed out after 1 hour',
    error_type: 'timeout'
  });
  process.exit(1);
}, TIMEOUT_MS);

run()
  .then((code) => {
    clearTimeout(timeout);
    process.exit(code);
  })
  .catch(async (err) => {
    clearTimeout(timeout);
    console.error('Worker error:', err);
    await callback({
      status: 'failed',
      error: err.message,
      error_type: 'worker_error'
    });
    process.exit(1);
  });
