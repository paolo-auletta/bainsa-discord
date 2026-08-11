-- Board positions are roster seats, not single-member slots. Discord already
-- represents each position with one shared role, so multiple active members
-- can safely hold the same university VP or division Head position.

DROP INDEX IF EXISTS board_assignments_active_head_per_division_unique;
DROP INDEX IF EXISTS board_assignments_active_vp_per_university_unique;
