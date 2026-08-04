-- An executive appointment supersedes membership and Head assignments in its university.
-- Keep this invariant in Postgres so every writer, not only /board-assign, preserves it.

CREATE OR REPLACE FUNCTION clear_division_assignments_for_executive_promotion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.active AND NEW.role IN ('vice_president', 'president') THEN
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

DROP TRIGGER IF EXISTS board_assignments_clear_division_roles_on_executive_promotion
  ON board_assignments;
CREATE TRIGGER board_assignments_clear_division_roles_on_executive_promotion
BEFORE INSERT OR UPDATE OF active, role ON board_assignments
FOR EACH ROW
EXECUTE FUNCTION clear_division_assignments_for_executive_promotion();
