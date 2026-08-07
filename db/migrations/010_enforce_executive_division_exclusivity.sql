-- Replace the initial promotion trigger with deferred checks. This sees complete
-- multi-row statements and serializes competing writes for one member/university.

DROP TRIGGER IF EXISTS board_assignments_clear_division_roles_on_executive_promotion
  ON board_assignments;
DROP FUNCTION IF EXISTS clear_division_assignments_for_executive_promotion();

-- Repair pre-existing data before the deferred triggers enforce this invariant
-- for future writes. Scope cleanup to the executive's own university.
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

CREATE CONSTRAINT TRIGGER board_assignments_enforce_executive_division_exclusivity
AFTER INSERT OR UPDATE OF active, role, university_id, discord_user_id ON board_assignments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_executive_board_assignment_exclusivity();

CREATE CONSTRAINT TRIGGER member_divisions_enforce_executive_division_exclusivity
AFTER INSERT OR UPDATE OF discord_user_id, division_id ON member_divisions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_executive_member_division_exclusivity();
