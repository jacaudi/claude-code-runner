import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function migrate() {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL
  });

  const schema = readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');

  try {
    await pool.query(schema);
    console.log('Migration complete');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
