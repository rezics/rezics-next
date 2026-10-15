-- Sort hints are projections of the exact rating owner value.
ALTER TABLE reader.library_status DROP CONSTRAINT library_status_own_rating_check;
ALTER TABLE reader.library_status ALTER COLUMN own_rating TYPE numeric;
ALTER TABLE reader.library_status ADD CONSTRAINT library_status_own_rating_check
  CHECK (own_rating BETWEEN 0 AND 1000000 AND scale(own_rating) <= 6);
