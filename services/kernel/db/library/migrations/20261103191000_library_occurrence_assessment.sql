-- migrate:up
ALTER TABLE library.progress_session
  ADD COLUMN journal_assessment_units smallint,
  ADD COLUMN journal_assessment_meaning_revision smallint NOT NULL DEFAULT 1,
  ADD CONSTRAINT progress_session_journal_assessment_units_check CHECK (
    journal_assessment_units IS NULL OR journal_assessment_units BETWEEN 0 AND 20
  ),
  ADD CONSTRAINT progress_session_journal_assessment_meaning_revision_check CHECK (
    journal_assessment_meaning_revision = 1
  );

-- migrate:down
-- Forward only: occurrence assessments are retained private journal data.
