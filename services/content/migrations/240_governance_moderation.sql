-- A moderation decision observes and accepts one exact draft head in the
-- Content transaction that serializes with draft.save on the variant row.
INSERT INTO content.receipt_action (action) VALUES ('moderation.apply') ON CONFLICT DO NOTHING;

CREATE TABLE content.moderation_effect (
  operation_id text PRIMARY KEY REFERENCES content.receipt(operation_id),
  decision_operation_id text NOT NULL,
  target_ordinal smallint NOT NULL CHECK (target_ordinal BETWEEN 1 AND 64),
  resource_id text NOT NULL,
  variant_id text NOT NULL REFERENCES content.variant(id),
  expected_head uuid NOT NULL,
  effect text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  UNIQUE (decision_operation_id, target_ordinal)
);
CREATE INDEX moderation_effect_variant ON content.moderation_effect (variant_id, expected_head);
CREATE TRIGGER moderation_effect_immutable BEFORE UPDATE OR DELETE ON content.moderation_effect
  FOR EACH ROW EXECUTE FUNCTION content.no_mutation();
