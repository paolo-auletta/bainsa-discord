-- Consolidate the short-lived multi-message profile presentation back into a
-- single starter message. Queue every published profile so reconciliation can
-- replace the starter and remove the two legacy managed follow-ups.

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
