import pg from 'pg';

let pool = null;

export function initDb() {
  if (!process.env.DATABASE_URL) {
    console.log('DATABASE_URL not set, using in-memory fallback');
    return false;
  }

  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL
  });

  pool.on('error', (err) => {
    console.error('Database pool error:', err.message);
  });

  return true;
}

export function isDbEnabled() {
  return pool !== null;
}

export async function createTask(id, prompt) {
  if (!pool) throw new Error('Database not initialized');

  await pool.query(
    'INSERT INTO tasks (id, prompt, status, created_at) VALUES ($1, $2, $3, $4)',
    [id, prompt, 'pending', new Date()]
  );
}

export async function getTask(id) {
  if (!pool) throw new Error('Database not initialized');

  const result = await pool.query('SELECT * FROM tasks WHERE id = $1', [id]);
  return result.rows[0] || null;
}

export async function listTasks(limit = 50) {
  if (!pool) throw new Error('Database not initialized');

  const result = await pool.query(
    'SELECT * FROM tasks ORDER BY created_at DESC LIMIT $1',
    [limit]
  );
  return result.rows;
}

export async function updateTask(id, updates) {
  if (!pool) throw new Error('Database not initialized');

  const fields = Object.keys(updates);
  if (fields.length === 0) return;

  const values = Object.values(updates);
  const setClause = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');

  await pool.query(
    `UPDATE tasks SET ${setClause} WHERE id = $1`,
    [id, ...values]
  );
}

export async function closeDb() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
