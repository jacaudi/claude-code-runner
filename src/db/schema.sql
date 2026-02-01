CREATE TABLE IF NOT EXISTS tasks (
    id VARCHAR(8) PRIMARY KEY,
    prompt TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',

    repository VARCHAR(255),
    branch VARCHAR(255),
    pr_url VARCHAR(255),
    error TEXT,
    error_type VARCHAR(50),

    worker_pod VARCHAR(255),
    worker_job VARCHAR(255),

    created_at TIMESTAMP DEFAULT NOW(),
    started_at TIMESTAMP,
    completed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);
