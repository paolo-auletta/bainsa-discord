-- Replace the derived Researcher/Alumni forum-tag classification with the
-- member's canonical BAINSA university. Reconciliation updates every
-- published thread after provisioning has installed the three university tags.

INSERT INTO member_profile_reconciliation (
  discord_user_id,
  desired_generation,
  status,
  attempts,
  requested_at,
  started_at,
  succeeded_at,
  failed_at,
  last_error
)
SELECT
  discord_user_id,
  1,
  'pending',
  0,
  now(),
  NULL,
  NULL,
  NULL,
  NULL
FROM member_profiles
WHERE visibility = 'published'
ON CONFLICT (discord_user_id) DO UPDATE
SET desired_generation = member_profile_reconciliation.desired_generation + 1,
    status = 'pending',
    attempts = 0,
    requested_at = now(),
    started_at = NULL,
    succeeded_at = NULL,
    failed_at = NULL,
    last_error = NULL;
