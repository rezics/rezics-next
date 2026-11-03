-- migrate:up
ALTER TABLE library.copy_archive_progress_apply
  ADD COLUMN session_revision integer CHECK (session_revision BETWEEN 1 AND 2147483646),
  ADD COLUMN active_started boolean NOT NULL DEFAULT false,
  ADD COLUMN active_command jsonb CHECK (
    active_command IS NULL OR
    (jsonb_typeof(active_command) = 'object' AND octet_length(active_command::text) <= 8192)
  );

-- An older in-flight step did not retain its native operands. Its original
-- receipt cannot be replayed safely if a newer Session revision was observed.
UPDATE library.copy_archive_progress_apply
SET state='failed',error_code='recovery_operands_unavailable',active_step=NULL
WHERE state='applying' AND active_step IS NOT NULL;

-- A completed checkpoint determines the expected next revision: create starts
-- at revision 1 and every accepted recovery step advances it once.
UPDATE library.copy_archive_progress_apply
SET session_revision=next_step
WHERE session_id IS NOT NULL AND next_step > 0 AND session_revision IS NULL;

ALTER TABLE library.copy_archive_progress_apply
  ADD CONSTRAINT copy_archive_progress_active_command_check
  CHECK ((active_step IS NULL) = (active_command IS NULL) AND (active_step IS NOT NULL OR active_started = false));

-- migrate:down
ALTER TABLE library.copy_archive_progress_apply
  DROP CONSTRAINT copy_archive_progress_active_command_check,
  DROP COLUMN active_started,
  DROP COLUMN active_command,
  DROP COLUMN session_revision;
