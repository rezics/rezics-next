-- migrate:up
-- Temporary unpinned rows retain the fixed vocabulary until writer/backfill cutover.
-- The existing pin shape checks still reject JSON null and malformed provenance.
ALTER TABLE library.entry
  DROP CONSTRAINT entry_state_check,
  ADD CONSTRAINT entry_state_check CHECK (
    (library_profile_pin IS NULL AND state IN ('planned', 'in_progress', 'completed', 'paused', 'dropped')) OR
    (library_profile_pin IS NOT NULL AND char_length(state) > 0)
  ) NOT VALID;

ALTER TABLE library.copy
  DROP CONSTRAINT copy_status_check,
  ADD CONSTRAINT copy_status_check CHECK (
    (library_profile_pin IS NULL AND status IN ('ordered', 'owned', 'lent', 'disposed')) OR
    (library_profile_pin IS NOT NULL AND char_length(status) > 0)
  ) NOT VALID;

ALTER TABLE library.progress_session
  DROP CONSTRAINT progress_session_unit_check,
  ADD CONSTRAINT progress_session_unit_check CHECK (
    (library_profile_pin IS NULL AND unit IN ('page', 'chapter', 'episode', 'volume', 'minute', 'percent')) OR
    (library_profile_pin IS NOT NULL AND char_length(unit) > 0)
  ) NOT VALID,
  DROP CONSTRAINT progress_session_check2,
  ADD CONSTRAINT progress_session_check2 CHECK (
    library_profile_pin IS NOT NULL OR unit <> 'percent' OR
    ((amount IS NULL OR amount <= 100) AND (total IS NULL OR total <= 100))
  ) NOT VALID;

-- migrate:down
-- Forward-only: pinned data IDs cannot be represented by the old fixed checks.
