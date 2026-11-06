-- migrate:up
-- One native control row. It records raw examination, never consumer readiness.
CREATE TABLE auth_workflow_retention (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  cutoff bigint,
  through_key text,
  after_key text,
  CHECK (cutoff IS NOT NULL OR (through_key IS NULL AND after_key IS NULL)),
  CHECK (after_key IS NULL OR (through_key IS NOT NULL AND after_key <= through_key))
);
INSERT INTO auth_workflow_retention (singleton) VALUES (true);

-- migrate:down
DROP TABLE auth_workflow_retention;
