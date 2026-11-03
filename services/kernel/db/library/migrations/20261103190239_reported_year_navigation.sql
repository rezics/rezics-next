-- migrate:up
-- Native journal keys receive corrections, completion and retirement atomically with
-- the existing summary trigger. No copied occurrence facts or read-time backfill.
CREATE INDEX progress_session_reported_year_diary
  ON library.progress_session(route,account_id,journal_finish_year,started_at DESC,session_id DESC)
  WHERE state='completed'
    AND library.reported_finish_valid(journal_finish_year,journal_finish_month,journal_finish_day);
CREATE INDEX progress_session_reported_bucket_diary
  ON library.progress_session(route,account_id,journal_finish_year,(COALESCE(journal_finish_month,13)),
    started_at DESC,session_id DESC)
  WHERE state='completed'
    AND library.reported_finish_valid(journal_finish_year,journal_finish_month,journal_finish_day);

-- migrate:down
DROP INDEX library.progress_session_reported_bucket_diary;
DROP INDEX library.progress_session_reported_year_diary;
