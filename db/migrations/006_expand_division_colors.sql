-- Expand division colors while preserving the existing semantic keys.

ALTER TABLE divisions
  DROP CONSTRAINT IF EXISTS divisions_color_check;

ALTER TABLE divisions
  ADD CONSTRAINT divisions_color_check
  CHECK (color IN ('red', 'orange', 'yellow', 'green', 'blue', 'pink', 'brown', 'black'));
