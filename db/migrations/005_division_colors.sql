-- Give every division a stable semantic color used by Discord roles and UI labels.

ALTER TABLE divisions
  ADD COLUMN IF NOT EXISTS color text NOT NULL DEFAULT 'blue';

UPDATE divisions
   SET color = CASE lower(trim(name))
     WHEN 'analysis' THEN 'orange'
     WHEN 'culture' THEN 'pink'
     ELSE 'blue'
   END
 WHERE color IS NULL OR color = 'blue';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.divisions'::regclass
      AND conname = 'divisions_color_check'
  ) THEN
    ALTER TABLE divisions
      ADD CONSTRAINT divisions_color_check
      CHECK (color IN ('blue', 'orange', 'pink'));
  END IF;
END;
$$;
