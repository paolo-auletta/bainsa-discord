-- A division move would need to coordinate member memberships, board roles,
-- projects, and Discord resources. Until such a workflow exists, fail closed
-- instead of allowing direct updates to bypass university-scoped invariants.

CREATE OR REPLACE FUNCTION prevent_division_university_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.university_id IS DISTINCT FROM OLD.university_id THEN
    RAISE EXCEPTION 'division university_id is immutable';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS divisions_prevent_university_change ON divisions;
CREATE TRIGGER divisions_prevent_university_change
BEFORE UPDATE OF university_id ON divisions
FOR EACH ROW
EXECUTE FUNCTION prevent_division_university_change();
