-- Receipt actions are registered rows. An owner migration adds its actions with
-- INSERT ... ON CONFLICT DO NOTHING instead of re-listing a CHECK constraint, so
-- migrations from parallel owner work cannot drop each other's actions.
CREATE TABLE content.receipt_action (
  action text PRIMARY KEY CHECK (action ~ '^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$')
);
INSERT INTO content.receipt_action (action) VALUES
  ('draft.save'), ('publication.prepare'), ('publication.settle'), ('comment.create');
ALTER TABLE content.receipt DROP CONSTRAINT receipt_action_check;
ALTER TABLE content.receipt ADD CONSTRAINT receipt_action_registered
  FOREIGN KEY (action) REFERENCES content.receipt_action (action);
