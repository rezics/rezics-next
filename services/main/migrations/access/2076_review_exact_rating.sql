-- Review copies retain the precision of the linked native standing score.
ALTER TABLE access.reader_review DROP CONSTRAINT reader_review_rating_check;
ALTER TABLE access.reader_review ALTER COLUMN rating TYPE numeric;
ALTER TABLE access.reader_review ADD CONSTRAINT reader_review_rating_check
  CHECK (rating BETWEEN 0 AND 1000000 AND scale(rating) <= 6);
ALTER TABLE access.reader_review_revision DROP CONSTRAINT reader_review_revision_rating_check;
ALTER TABLE access.reader_review_revision ALTER COLUMN rating TYPE numeric;
ALTER TABLE access.reader_review_revision ADD CONSTRAINT reader_review_revision_rating_check
  CHECK (rating BETWEEN 0 AND 1000000 AND scale(rating) <= 6);
