-- Durable desired Discord state for each project.  The generation is advanced
-- in the same transaction as every project mutation.

CREATE TABLE IF NOT EXISTS project_reconciliation (
  project_id bigint PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  desired_generation bigint NOT NULL DEFAULT 0 CHECK (desired_generation >= 0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'succeeded', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  succeeded_at timestamptz,
  failed_at timestamptz,
  last_error text
);

CREATE INDEX IF NOT EXISTS project_reconciliation_repair_idx
  ON project_reconciliation (status, requested_at, project_id);

-- Existing projects predate this durable queue. Seed them so the repair worker
-- reconciles their Discord state after an upgrade as well as after new writes.
INSERT INTO project_reconciliation (project_id, desired_generation, status)
SELECT id, 1, 'pending'
FROM projects
ON CONFLICT (project_id) DO NOTHING;
