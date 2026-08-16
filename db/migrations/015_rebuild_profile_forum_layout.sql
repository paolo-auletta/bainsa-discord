-- The profile presentation changed from one dense starter message to three
-- managed sections. Queue every published profile once so existing directory
-- posts adopt the new layout after deployment without requiring an owner edit.

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
