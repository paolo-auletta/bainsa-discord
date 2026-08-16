-- Migration 010 was already deployed before its data repair and transaction
-- isolation checks were added locally. Preserve the deployed migration checksum
-- and apply those enhancements here as an append-only upgrade.

WITH executive_assignments AS (
  SELECT DISTINCT discord_user_id, university_id
    FROM board_assignments
   WHERE role IN ('vice_president', 'president')
     AND active = true
)
DELETE FROM member_divisions AS md
USING divisions AS d, executive_assignments AS executive
WHERE md.division_id = d.id
  AND md.discord_user_id = executive.discord_user_id
  AND d.university_id = executive.university_id;

WITH executive_assignments AS (
  SELECT DISTINCT discord_user_id, university_id
    FROM board_assignments
   WHERE role IN ('vice_president', 'president')
     AND active = true
)
UPDATE board_assignments AS head
   SET active = false,
       updated_at = now()
  FROM executive_assignments AS executive
 WHERE head.discord_user_id = executive.discord_user_id
   AND head.university_id = executive.university_id
   AND head.role = 'head'
   AND head.active = true;

CREATE OR REPLACE FUNCTION enforce_executive_board_assignment_exclusivity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Executive division exclusivity requires READ COMMITTED transactions.';
  END IF;

  IF NEW.university_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(NEW.discord_user_id),
    hashtext(NEW.university_id::text)
  );

  IF EXISTS (
    SELECT 1
      FROM board_assignments
     WHERE discord_user_id = NEW.discord_user_id
       AND university_id = NEW.university_id
       AND role IN ('vice_president', 'president')
       AND active = true
  ) THEN
    DELETE FROM member_divisions AS md
    USING divisions AS d
    WHERE md.division_id = d.id
      AND md.discord_user_id = NEW.discord_user_id
      AND d.university_id = NEW.university_id;

    UPDATE board_assignments
       SET active = false,
           updated_at = now()
     WHERE discord_user_id = NEW.discord_user_id
       AND university_id = NEW.university_id
       AND role = 'head'
       AND active = true;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_executive_member_division_exclusivity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  member_university_id bigint;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Executive division exclusivity requires READ COMMITTED transactions.';
  END IF;

  SELECT university_id
    INTO member_university_id
    FROM divisions
   WHERE id = NEW.division_id;

  PERFORM pg_advisory_xact_lock(
    hashtext(NEW.discord_user_id),
    hashtext(member_university_id::text)
  );

  IF EXISTS (
    SELECT 1
      FROM board_assignments
     WHERE discord_user_id = NEW.discord_user_id
       AND university_id = member_university_id
       AND role IN ('vice_president', 'president')
       AND active = true
  ) THEN
    DELETE FROM member_divisions AS md
    USING divisions AS d
    WHERE md.division_id = d.id
      AND md.discord_user_id = NEW.discord_user_id
      AND d.university_id = member_university_id;
  END IF;

  RETURN NEW;
END;
$$;
