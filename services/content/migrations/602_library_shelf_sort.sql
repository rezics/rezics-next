-- The three owner-maintained keys keep shelf sorting in PostgreSQL. Empty title
-- marks only pre-migration rows for the bounded, restartable graph backfill.
ALTER TABLE reader.library_status
  ADD COLUMN title_key text,
  ADD COLUMN own_rating integer CHECK (own_rating BETWEEN 1 AND 5),
  ADD COLUMN last_read_at timestamptz;
UPDATE reader.library_status SET title_key = '';

-- Added order uses library_status_shelf; finished range reads retain
-- library_status_finished_year. These cover complete keysets, including ties.
CREATE INDEX library_status_finished_shelf ON reader.library_status (agent, status, finished_on, work)
  WHERE status IS NOT NULL;
CREATE INDEX library_status_title_shelf ON reader.library_status (agent, status, title_key COLLATE "C", work)
  WHERE status IS NOT NULL;
CREATE INDEX library_status_rating_shelf ON reader.library_status (agent, status, own_rating, work)
  WHERE status IS NOT NULL;
CREATE INDEX library_status_last_read_shelf ON reader.library_status (agent, status, last_read_at, work)
  WHERE status IS NOT NULL;
-- Empty after the conversion; prevents repeatedly sorting the remaining frozen
-- inventory while the restartable backfill drains bounded batches.
CREATE INDEX library_status_backfill ON reader.library_status (changed_at DESC, work DESC)
  WHERE title_key = '';
