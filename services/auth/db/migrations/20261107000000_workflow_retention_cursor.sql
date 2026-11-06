-- migrate:up
-- One native control row. It records the supported SDK continuation, never consumer readiness.
CREATE TABLE auth_workflow_retention (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  continuation jsonb
);
INSERT INTO auth_workflow_retention (singleton) VALUES (true);

-- migrate:down
DROP TABLE auth_workflow_retention;
