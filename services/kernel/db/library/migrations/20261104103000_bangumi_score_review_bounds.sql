-- migrate:up
-- Bound the exact score review, confirmed operands and returned outcomes in the existing retained row.
ALTER TABLE library.bangumi_upload_row
  ADD CONSTRAINT bangumi_score_review_bytes
    CHECK (review IS NULL OR octet_length(review::text) <= 71680),
  ADD CONSTRAINT bangumi_score_choice_bytes
    CHECK (choice IS NULL OR octet_length(choice::text) <= 8192),
  ADD CONSTRAINT bangumi_score_outcome_bytes
    CHECK (outcome IS NULL OR octet_length(outcome::text) <= 16384);
-- migrate:down
ALTER TABLE library.bangumi_upload_row
  DROP CONSTRAINT bangumi_score_review_bytes,
  DROP CONSTRAINT bangumi_score_choice_bytes,
  DROP CONSTRAINT bangumi_score_outcome_bytes;
