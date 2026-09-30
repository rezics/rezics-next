-- Review prose is independent of a score; linked score evidence is all-or-none.
ALTER TABLE access.reader_review
  ALTER COLUMN main_version DROP NOT NULL,
  ALTER COLUMN rating DROP NOT NULL,
  ALTER COLUMN rating_observation DROP NOT NULL,
  ALTER COLUMN rating_revision DROP NOT NULL,
  ADD CONSTRAINT reader_review_score_evidence CHECK (
    num_nonnulls(rating, rating_observation, rating_revision) IN (0,3));
ALTER TABLE access.reader_review_revision
  ALTER COLUMN rating DROP NOT NULL,
  ALTER COLUMN rating_observation DROP NOT NULL,
  ALTER COLUMN rating_revision DROP NOT NULL,
  ADD CONSTRAINT reader_review_revision_score_evidence CHECK (
    num_nonnulls(rating, rating_observation, rating_revision) IN (0,3));

-- Generic exact targets have their own completeness witness. No MainVersion or
-- FixedRelease inventory can select these rows, even when an IRI is shared.
CREATE TABLE access.target_rating_head (
  context text NOT NULL REFERENCES access.rating_aggregate_context(context),
  target text NOT NULL,
  slot text NOT NULL CHECK (slot ~ '^urn:rezics:rating-slot:[0-9a-f]{64}$'),
  observation text NOT NULL UNIQUE,
  revision text NOT NULL UNIQUE,
  principal_id uuid NOT NULL REFERENCES access.principal(id),
  admission_id uuid NOT NULL UNIQUE REFERENCES access.admission(id),
  original_admission_id uuid NOT NULL REFERENCES access.admission(id),
  PRIMARY KEY (context, target, slot)
);
CREATE INDEX target_rating_head_principal ON access.target_rating_head(principal_id);
CREATE INDEX target_rating_head_original ON access.target_rating_head(original_admission_id);
