-- migrate:up
CREATE INDEX fact_label ON semantic.fact (route, subject_id, language)
  WHERE kind = 'label' AND operation = 'assert';

-- Rows inserted without a release, including the frozen subject-growth fixture, still name one.
ALTER TABLE semantic.subject
  ALTER COLUMN current_release SET DEFAULT 'sha256:0000000000000000000000000000000000000000000000000000000000000000';

-- migrate:down
ALTER TABLE semantic.subject ALTER COLUMN current_release DROP DEFAULT;

DROP INDEX semantic.fact_label;
