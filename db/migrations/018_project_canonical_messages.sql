ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS home_message_id text,
  ADD COLUMN IF NOT EXISTS summary text;

-- Every existing project needs to adopt or create the redesigned canonical
-- private home and public showcase record, including already-completed work.
INSERT INTO project_reconciliation (project_id, desired_generation, status, requested_at, last_error)
SELECT id, 1, 'pending', now(), NULL
FROM projects
ON CONFLICT (project_id) DO UPDATE
  SET desired_generation = project_reconciliation.desired_generation + 1,
      status = 'pending',
      requested_at = now(),
      last_error = NULL;
