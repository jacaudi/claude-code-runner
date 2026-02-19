import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { mkdir, rm, appendFile, readFile, writeFile, access } from 'fs/promises';
import { createWriteStream, createReadStream, existsSync, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { createDispatcher } from './dispatchers/index.js';
import { RedisQueue } from './queue/redis.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session configuration
const SESSION_SECRET = process.env.SESSION_SECRET || randomUUID();
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production' && process.env.HTTPS === 'true',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Data directory and file paths
const DATA_DIR = process.env.DATA_DIR || '/data';
const AUTH_FILE = process.env.AUTH_FILE || path.join(DATA_DIR, 'auth.json');
const TOKEN_FILE = path.join(DATA_DIR, 'token.json');

// API Token management
function loadToken() {
  try {
    if (existsSync(TOKEN_FILE)) {
      const data = JSON.parse(readFileSync(TOKEN_FILE, 'utf-8'));
      return data.token || null;
    }
  } catch (e) {
    console.error('Failed to load token:', e.message);
  }
  return null;
}

function saveToken(token) {
  try {
    writeFileSync(TOKEN_FILE, JSON.stringify({ token, created: new Date().toISOString() }), 'utf-8');
  } catch (e) {
    console.error('Failed to save token:', e.message);
  }
}

function generateToken() {
  return 'ccr_' + randomUUID().replace(/-/g, '');
}

let currentToken = loadToken();

// Load or initialize auth data
async function loadAuthData() {
  try {
    await access(AUTH_FILE);
    const data = await readFile(AUTH_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function saveAuthData(data) {
  const dir = path.dirname(AUTH_FILE);
  await mkdir(dir, { recursive: true });
  await writeFile(AUTH_FILE, JSON.stringify(data, null, 2));
}

async function isSetupComplete() {
  const auth = await loadAuthData();
  return auth !== null && auth.username && auth.passwordHash;
}

// Auth middleware
async function requireAuth(req, res, next) {
  const setupComplete = await isSetupComplete();

  // Allow setup page and setup POST when not configured
  if (!setupComplete) {
    if (req.path === '/setup' || req.path === '/api/setup') {
      return next();
    }
    return res.redirect('/setup');
  }

  // Allow login page and login POST when not authenticated
  if (req.path === '/login' || req.path === '/api/login') {
    return next();
  }

  // Allow token management endpoints (protected by being first-time setup or showing masked values)
  if (req.path === '/token' || req.path === '/token/generate') {
    return next();
  }

  // Allow health check for external monitoring
  if (req.path === '/health') {
    return next();
  }

  // Check session auth first (for browser users)
  if (req.session && req.session.authenticated) {
    return next();
  }

  // Check Bearer token auth (for API clients)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (currentToken && token === currentToken) {
      return next();
    }
  }

  // Not authenticated
  if (req.path.startsWith('/api/') || req.path.startsWith('/task')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.redirect('/login');
}

// Apply auth middleware to all routes except static assets
app.use(requireAuth);

// ============ Redis + Dispatcher Setup ============

const DISPATCH_MODE = process.env.DISPATCH_MODE || 'local';
const REDIS_URL = process.env.REDIS_URL;
const useRedis = DISPATCH_MODE === 'redis';

let redisQueue = null;

if (useRedis) {
  if (!REDIS_URL) {
    console.error('REDIS_URL is required when DISPATCH_MODE=redis');
    process.exit(1);
  }
  redisQueue = new RedisQueue(REDIS_URL);
  console.log(`[server] Redis mode enabled, connecting to ${REDIS_URL.replace(/\/\/.*@/, '//***@')}`);
}

const tasks = useRedis ? null : new Map(); // In-memory store only for local/k8s modes
const WORK_DIR = '/tmp/work';
const TASK_TIMEOUT = 60 * 60 * 1000; // 1 hour
const dispatcher = createDispatcher(undefined, { redisQueue });

// ============ Task State Helpers ============

/**
 * Unified task state accessors.
 * In Redis mode, reads/writes go to Redis.
 * In local/k8s mode, uses the in-memory Map.
 */
async function getTask(id) {
  if (useRedis) return redisQueue.getTask(id);
  return tasks.get(id) || null;
}

async function setTask(id, data) {
  if (useRedis) return redisQueue.setTask(id, data);
  tasks.set(id, data);
}

async function updateTask(id, fields) {
  if (useRedis) return redisQueue.updateTask(id, fields);
  const existing = tasks.get(id);
  if (existing) tasks.set(id, { ...existing, ...fields });
}

async function listAllTasks() {
  if (useRedis) return redisQueue.listTasks();
  const taskList = [...tasks.entries()].map(([id, task]) => ({ id, ...task }));
  taskList.sort((a, b) => new Date(b.started) - new Date(a.started));
  return taskList;
}

// ============ Auth Routes ============

// Setup page (first-time configuration)
app.get('/setup', async (req, res) => {
  if (await isSetupComplete()) {
    return res.redirect('/login');
  }
  const html = await readFile(path.join(__dirname, 'setup.html'), 'utf-8');
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// Setup API
app.post('/api/setup', async (req, res) => {
  if (await isSetupComplete()) {
    return res.status(400).json({ error: 'Setup already complete' });
  }

  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  if (username.length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await saveAuthData({ username, passwordHash });

  req.session.authenticated = true;
  req.session.username = username;

  res.json({ success: true });
});

// Login page
app.get('/login', async (req, res) => {
  if (!(await isSetupComplete())) {
    return res.redirect('/setup');
  }
  if (req.session && req.session.authenticated) {
    return res.redirect('/');
  }
  const html = await readFile(path.join(__dirname, 'login.html'), 'utf-8');
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// Login API
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const auth = await loadAuthData();
  if (!auth) {
    return res.status(400).json({ error: 'Setup not complete' });
  }

  if (username.toLowerCase() !== auth.username.toLowerCase()) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const valid = await bcrypt.compare(password, auth.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  req.session.authenticated = true;
  req.session.username = username;

  res.json({ success: true });
});

// Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.json({ success: true });
  });
});

// Get current user info
app.get('/api/me', (req, res) => {
  if (req.session && req.session.authenticated) {
    res.json({ username: req.session.username });
  } else {
    res.status(401).json({ error: 'Not authenticated' });
  }
});

// ============ API Token Management ============

// Generate new API token
app.post('/token/generate', (req, res) => {
  const token = generateToken();
  currentToken = token;
  saveToken(token);
  res.json({ token }); // Full token returned only on generation
});

// Get token status (masked)
app.get('/token', (req, res) => {
  if (!currentToken) {
    return res.json({ exists: false });
  }
  // Return masked token: ccr_a1b2...x9z0
  const masked = currentToken.slice(0, 8) + '...' + currentToken.slice(-4);
  res.json({ exists: true, masked });
});

// Revoke token
app.delete('/token', (req, res) => {
  currentToken = null;
  try {
    if (existsSync(TOKEN_FILE)) {
      writeFileSync(TOKEN_FILE, JSON.stringify({ token: null }), 'utf-8');
    }
  } catch (e) {
    console.error('Failed to revoke token:', e.message);
  }
  res.json({ ok: true });
});

// ============ System Prompts ============

function getWorkerSystemPrompt(branchName) {
  return `
# Autonomous Worker Mode

You are running autonomously. No human in the loop.

## Git Setup
You are on branch ${branchName}. It's already pushed to origin.

## Rules
- NEVER use AskUserQuestion - you will hang forever
- NEVER exit without pushing your commits
- Make reasonable assumptions, document them in commits

## Context Management
Your context window is precious. DO NOT run more than 3-4 search commands yourself.
- Use Task tool with subagent_type=Explore for any codebase exploration
- Use Task tool for self-contained subtasks
- Keep main thread for coordination and git operations

## Git Workflow
Commit as a software engineer would - logical chunks of work, meaningful messages.
The only hard rule: ALWAYS push before you exit. Your work is lost if it's not pushed.

## FINAL STEP (MANDATORY)
Before exiting, you MUST run these commands:
1. git add -A && git commit -m "<summary of changes>" (if any uncommitted changes)
2. git push
3. gh pr create --title "<task summary>" --body "<description of changes>"

If blocked or failed: still push and create PR, note what went wrong in the PR body.
`.trim();
}

function getOrchestratorPrompt(prompt, workDir, branchName) {
  return `
You are an orchestrator. Your job is to:
1. Figure out which repo the user is asking about
2. Clone it and set up the environment
3. Create and push a feature branch

Workflow:
1. Configure git to use the GitHub token:
   git config --global credential.helper '!f() { echo "username=x-access-token"; echo "password=$GH_TOKEN"; }; f'
2. Use gh CLI to list repos and identify the right one from the user's prompt
3. Clone to ${workDir}/repo
4. Examine the repo to identify required tools (check README, config files, lock files)
5. Check what tools are already available, install anything missing
6. Run dependency installation (npm install, pip install, go mod download, etc.)
7. Create and push the feature branch:
   git checkout -b ${branchName}
   git commit --allow-empty -m "chore: start task"
   git push -u origin HEAD
8. Exit successfully

Do NOT start working on the actual task - just prepare the environment.

User request: ${prompt}
`.trim();
}


app.post('/task', async (req, res) => {
  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'prompt required' });
  }

  const id = randomUUID().slice(0, 8);
  const taskDir = path.join(WORK_DIR, id);

  if (!useRedis) {
    await mkdir(taskDir, { recursive: true });
  }

  await setTask(id, {
    status: 'running',
    prompt,
    started: new Date().toISOString(),
    logFile: path.join(taskDir, 'output.log')
  });

  runTask(id, prompt, taskDir).catch(async (err) => {
    await updateTask(id, {
      status: 'failed',
      error: err.message,
      errorType: err.errorType || 'unknown',
      finished: new Date().toISOString()
    });
  });

  res.json({ id, status: 'queued' });
});

app.get('/task/:id', async (req, res) => {
  const task = await getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  res.json({ id: req.params.id, ...task });
});

app.get('/task/:id/logs', async (req, res) => {
  const task = await getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });

  res.setHeader('Content-Type', 'text/plain');

  if (useRedis) {
    // Serve logs from Redis buffer
    const logs = await redisQueue.getLogBuffer(req.params.id);
    res.send(logs);
  } else {
    createReadStream(task.logFile).pipe(res);
  }
});

app.get('/health', async (req, res) => {
  const health = {
    ok: true,
    dispatchMode: DISPATCH_MODE,
  };

  if (useRedis) {
    try {
      health.redisConnected = await redisQueue.ping();
    } catch {
      health.redisConnected = false;
      health.ok = false;
    }
    // Count tasks from Redis
    const allTasks = await redisQueue.listTasks().catch(() => []);
    health.tasks = allTasks.length;
    health.running = allTasks.filter(t => t.status === 'running').length;
  } else {
    health.tasks = tasks.size;
    health.running = [...tasks.values()].filter(t => t.status === 'running').length;
  }

  res.json(health);
});

// List all tasks
app.get('/tasks', async (req, res) => {
  const taskList = await listAllTasks();
  res.json(taskList);
});

// Dashboard UI
app.get('/', async (req, res) => {
  const html = await readFile(path.join(__dirname, 'dashboard.html'), 'utf-8');
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

async function runTask(id, prompt, taskDir) {
  const logFile = path.join(taskDir, 'output.log');
  const repoDir = path.join(taskDir, 'repo');
  const branchName = `claude/${id}`;

  if (useRedis) {
    // In Redis mode, both phases are dispatched as separate queue items.
    // The worker pod handles the actual execution.
    await runRedisOrchestrator(id, prompt, taskDir, branchName);
    await runRedisWorker(id, prompt, repoDir, branchName);
    return;
  }

  // Local / K8s mode: run inline
  await appendFile(logFile, `=== Task started: ${new Date().toISOString()} ===\n`);
  await appendFile(logFile, `ID: ${id}\n`);
  await appendFile(logFile, `Prompt: ${prompt}\n\n`);

  // Phase 1: Orchestrator - identify and clone repo
  await appendFile(logFile, `\n=== ORCHESTRATOR PHASE ===\n`);
  await runOrchestrator(id, prompt, taskDir, branchName, logFile);
  await appendFile(logFile, `\n=== ORCHESTRATOR COMPLETE ===\n\n`);

  // Phase 2: Worker - run in cloned repo
  await appendFile(logFile, `=== WORKER PHASE ===\n`);
  const result = await runWorker(id, prompt, repoDir, branchName, logFile);
  await appendFile(logFile, `\n=== WORKER COMPLETE ===\n`);

  return result;
}

// ============ Redis-dispatched Phases ============

async function runRedisOrchestrator(id, prompt, taskDir, branchName) {
  const fullPrompt = getOrchestratorPrompt(prompt, taskDir, branchName);

  return new Promise((resolve, reject) => {
    const proc = dispatcher.spawn('claude', [
      '-p', fullPrompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions'
    ], {
      cwd: taskDir,
      env: {
        ...process.env,
        GH_TOKEN: process.env.GITHUB_TOKEN
      },
      cols: 200,
      rows: 50,
      taskId: `${id}-orch`,
      phase: 'orchestrator',
      prompt: fullPrompt,
    });

    const timeout = setTimeout(() => {
      proc.kill();
      const err = new Error('Orchestrator timed out');
      err.errorType = 'timeout';
      reject(err);
    }, 20 * 60 * 1000);

    console.log(`[${id}] Orchestrator dispatched to Redis queue`);

    proc.onData(() => {}); // Logs are handled by Redis pub/sub

    proc.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      if (exitCode !== 0) {
        return reject(new Error(`Orchestrator exited with code ${exitCode}`));
      }
      console.log(`[${id}] Orchestrator completed successfully`);
      resolve();
    });
  });
}

async function runRedisWorker(id, prompt, repoDir, branchName) {
  const systemPrompt = getWorkerSystemPrompt(branchName);

  return new Promise((resolve, reject) => {
    const proc = dispatcher.spawn('claude', [
      '-p', prompt,
      '--system-prompt', systemPrompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions'
    ], {
      cwd: repoDir,
      env: {
        ...process.env,
        GH_TOKEN: process.env.GITHUB_TOKEN
      },
      cols: 200,
      rows: 50,
      taskId: `${id}-worker`,
      phase: 'worker',
      prompt,
    });

    const timeout = setTimeout(() => {
      proc.kill();
      const err = new Error('Worker timed out after 1 hour');
      err.errorType = 'timeout';
      reject(err);
    }, TASK_TIMEOUT);

    console.log(`[${id}] Worker dispatched to Redis queue`);

    let output = '';
    proc.onData((data) => { output += data; });

    proc.onExit(async ({ exitCode }) => {
      clearTimeout(timeout);

      const prMatch = output.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);

      await updateTask(id, {
        status: exitCode === 0 ? 'completed' : 'failed',
        pr_url: prMatch?.[0] || null,
        errorType: exitCode === 0 ? null : 'exit_code',
        finished: new Date().toISOString()
      });

      exitCode === 0 ? resolve() : reject(new Error(`Worker exited with code ${exitCode}`));
    });
  });
}

// ============ Local / K8s inline Phases ============

async function runOrchestrator(id, prompt, taskDir, branchName, logFile) {
  const logStream = createWriteStream(logFile, { flags: 'a' });
  const fullPrompt = getOrchestratorPrompt(prompt, taskDir, branchName);

  return new Promise((resolve, reject) => {
    const proc = dispatcher.spawn('claude', [
      '-p', fullPrompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions'
    ], {
      cwd: taskDir,
      env: {
        ...process.env,
        GH_TOKEN: process.env.GITHUB_TOKEN
      },
      cols: 200,
      rows: 50
    });

    const timeout = setTimeout(() => {
      proc.kill();
      const err = new Error('Orchestrator timed out');
      err.errorType = 'timeout';
      reject(err);
    }, 20 * 60 * 1000); // 20 min timeout for orchestrator (includes env setup)

    let output = '';

    console.log(`[${id}] Orchestrator spawned, pid: ${proc.pid}`);

    proc.onData(data => {
      output += data;
      logStream.write(data);
    });

    proc.onExit(async ({ exitCode }) => {
      clearTimeout(timeout);
      logStream.end();

      if (exitCode !== 0) {
        return reject(new Error(`Orchestrator exited with code ${exitCode}`));
      }

      console.log(`[${id}] Orchestrator completed successfully`);
      resolve();
    });
  });
}

async function runWorker(id, prompt, repoDir, branchName, logFile) {
  const logStream = createWriteStream(logFile, { flags: 'a' });
  const systemPrompt = getWorkerSystemPrompt(branchName);

  return new Promise((resolve, reject) => {
    const proc = dispatcher.spawn('claude', [
      '-p', prompt,
      '--system-prompt', systemPrompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions'
    ], {
      cwd: repoDir,
      env: {
        ...process.env,
        GH_TOKEN: process.env.GITHUB_TOKEN
      },
      cols: 200,
      rows: 50
    });

    const timeout = setTimeout(() => {
      proc.kill();
      const err = new Error('Worker timed out after 1 hour');
      err.errorType = 'timeout';
      reject(err);
    }, TASK_TIMEOUT);

    let output = '';

    console.log(`[${id}] Worker spawned in ${repoDir}, pid: ${proc.pid}`);

    proc.onData(data => {
      output += data;
      logStream.write(data);
    });

    proc.onExit(async ({ exitCode }) => {
      clearTimeout(timeout);
      logStream.end();

      // Parse PR URL from worker output
      const prMatch = output.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);

      await updateTask(id, {
        status: exitCode === 0 ? 'completed' : 'failed',
        pr_url: prMatch?.[0] || null,
        errorType: exitCode === 0 ? null : 'exit_code',
        finished: new Date().toISOString()
      });

      // Cleanup cloned repo on success (keep logs)
      if (exitCode === 0) {
        await rm(repoDir, { recursive: true, force: true }).catch(() => {});
      }

      exitCode === 0 ? resolve() : reject(new Error(`Worker exited with code ${exitCode}`));
    });
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Claude Runner listening on :${PORT}`);
  console.log(`Dispatch mode: ${DISPATCH_MODE}`);
  if (useRedis) console.log(`Redis URL: ${REDIS_URL.replace(/\/\/.*@/, '//***@')}`);
});
