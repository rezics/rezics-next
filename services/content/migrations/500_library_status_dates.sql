-- Status-only edits preserve recorded dates on every shelf, including a cleared status.
ALTER TABLE reader.library_status DROP CONSTRAINT library_status_dates;
ALTER TABLE reader.library_status ADD CONSTRAINT library_status_dates
  CHECK (started_on IS NULL OR finished_on IS NULL OR started_on <= finished_on);
