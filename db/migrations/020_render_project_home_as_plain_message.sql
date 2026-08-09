-- Reconcile every project once so the existing canonical record is edited from
-- an embed into the plain-text project-home format.
INSERT INTO project_reconciliation (project_id, desired_generation, status, requested_at, last_error)
SELECT id, 1, 'pending', now(), NULL
FROM projects
ON CONFLICT (project_id) DO UPDATE
  SET desired_generation = project_reconciliation.desired_generation + 1,
      status = 'pending',
      requested_at = now(),
      last_error = NULL;
