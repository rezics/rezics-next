-- migrate:up
-- Sparse fact selection stays indexed by owner and seek key, including empty-section probes.
CREATE INDEX library_export_annotation_seek
  ON library.entry_personal_fact (route, account_id, subject_id)
  WHERE annotation_revision > 0;
CREATE INDEX library_export_journal_seek
  ON library.progress_session (route, account_id, session_id)
  WHERE state <> 'retired' AND journal_revision > 0;

-- migrate:down
-- Forward only: source-owned selection indexes.
