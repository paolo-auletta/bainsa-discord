-- Record the name supplied during onboarding and keep researcher onboarding
-- requests to one division. Existing members remain valid without a name.

ALTER TABLE members
  ADD COLUMN IF NOT EXISTS full_name text;

ALTER TABLE onboarding_requests
  ADD COLUMN IF NOT EXISTS full_name text;

ALTER TABLE onboarding_requests
  ADD COLUMN IF NOT EXISTS full_name_required boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.onboarding_requests'::regclass
      AND conname = 'onboarding_requests_submitted_name_check'
  ) THEN
    ALTER TABLE onboarding_requests
      ADD CONSTRAINT onboarding_requests_submitted_name_check
      CHECK (
        NOT full_name_required
        OR status IN ('draft', 'cancelled')
        OR char_length(trim(COALESCE(full_name, ''))) >= 2
      );
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION validate_onboarding_divisions()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  normalized_ids bigint[];
  input_count integer;
  distinct_count integer;
BEGIN
  normalized_ids := COALESCE(NEW.division_ids, ARRAY[]::bigint[]);
  NEW.division_ids := normalized_ids;

  SELECT COUNT(*), COUNT(DISTINCT division_id)
  INTO input_count, distinct_count
  FROM unnest(normalized_ids) AS division_id;

  IF input_count <> distinct_count THEN
    RAISE EXCEPTION 'onboarding division_ids cannot contain duplicates';
  END IF;

  IF NEW.member_type = 'alumni' AND cardinality(normalized_ids) <> 0 THEN
    RAISE EXCEPTION 'alumni onboarding requests must not include divisions';
  END IF;

  IF NEW.member_type = 'researcher' AND cardinality(normalized_ids) > 1 THEN
    RAISE EXCEPTION 'researcher onboarding requests can include only one division';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(normalized_ids) AS requested_division_id
    LEFT JOIN divisions
      ON divisions.id = requested_division_id
     AND divisions.university_id = NEW.university_id
    WHERE divisions.id IS NULL
  ) THEN
    RAISE EXCEPTION 'onboarding division_ids must belong to the selected university';
  END IF;

  RETURN NEW;
END;
$$;
