-- migrate:up
ALTER TABLE library.progress_session
  ADD COLUMN journal_assessment_meaning_revision smallint NOT NULL DEFAULT 1,
  ADD COLUMN journal_assessment_units smallint,
  ADD CONSTRAINT progress_session_journal_assessment_meaning_revision_check
    CHECK (journal_assessment_meaning_revision BETWEEN 1 AND 32767),
  ADD CONSTRAINT progress_session_journal_assessment_units_check
    CHECK (journal_assessment_units IS NULL OR journal_assessment_units BETWEEN 0 AND 20);

ALTER TABLE library.library_export
  DROP CONSTRAINT library_export_format_version_check,
  ADD CONSTRAINT library_export_format_version_check CHECK (format_version IN (1, 2, 3));

-- migrate:down
-- Forward only: private occurrence assessments are retained user data.
