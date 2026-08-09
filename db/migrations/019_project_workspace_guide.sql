ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS workspace_guide_message_id text;

-- Every existing project needs the separate pinned workspace guide created or
-- repaired alongside its canonical project record.
INSERT INTO project_reconciliation (project_id, desired_generation, status, requested_at, last_error)
SELECT id, 1, 'pending', now(), NULL
FROM projects
ON CONFLICT (project_id) DO UPDATE
  SET desired_generation = project_reconciliation.desired_generation + 1,
      status = 'pending',
      requested_at = now(),
      last_error = NULL;
