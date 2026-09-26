-- Recipient opt-in and a resumable Content-to-Access notification bridge.
-- Notification items/deliveries remain Access-owned; this cursor is only the
-- producer's durable position over immutable material correction notices.
ALTER TABLE verification.receipt DROP CONSTRAINT receipt_action_check;
ALTER TABLE verification.receipt ADD CONSTRAINT receipt_action_check CHECK (action IN
  ('origin.record', 'derivation.record', 'lineage.record', 'lineage.retract',
   'evidence.record', 'challenge.submit', 'challenge.resolve', 'source-disposition.record',
   'correction-subscription.set'));

CREATE TABLE verification.correction_subscription_revision (
  id uuid PRIMARY KEY,
  claim verification.rezics_id NOT NULL,
  context verification.iri NOT NULL,
  principal_id uuid NOT NULL,
  predecessor uuid,
  state text NOT NULL CHECK (state IN ('subscribed', 'unsubscribed')),
  operation_id uuid NOT NULL UNIQUE REFERENCES verification.receipt(id) DEFERRABLE INITIALLY DEFERRED,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (claim, context, principal_id, id),
  FOREIGN KEY (claim, context, principal_id, predecessor)
    REFERENCES verification.correction_subscription_revision(claim, context, principal_id, id)
);
CREATE TRIGGER correction_subscription_revision_immutable BEFORE UPDATE OR DELETE
  ON verification.correction_subscription_revision FOR EACH ROW EXECUTE FUNCTION verification.no_mutation();

CREATE TABLE verification.correction_subscription_head (
  claim verification.rezics_id NOT NULL,
  context verification.iri NOT NULL,
  principal_id uuid NOT NULL,
  head uuid NOT NULL,
  PRIMARY KEY (claim, context, principal_id),
  FOREIGN KEY (claim, context, principal_id, head)
    REFERENCES verification.correction_subscription_revision(claim, context, principal_id, id)
);
CREATE INDEX correction_subscription_recipients ON verification.correction_subscription_head
  (claim, context, principal_id);

CREATE TABLE verification.correction_delivery_cursor (
  generation_id uuid PRIMARY KEY REFERENCES verification.correction_notice(generation_id),
  cursor_principal uuid,
  complete boolean NOT NULL DEFAULT false,
  lease_owner text,
  lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((lease_owner IS NULL) = (lease_until IS NULL))
);
INSERT INTO verification.correction_delivery_cursor (generation_id)
  SELECT generation_id FROM verification.correction_notice;
CREATE INDEX correction_delivery_pending ON verification.correction_delivery_cursor
  (complete, lease_until, generation_id) WHERE NOT complete;
CREATE FUNCTION verification.queue_correction_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO verification.correction_delivery_cursor (generation_id) VALUES (NEW.generation_id);
  RETURN NULL;
END $$;
CREATE TRIGGER correction_delivery_queue AFTER INSERT ON verification.correction_notice
  FOR EACH ROW EXECUTE FUNCTION verification.queue_correction_delivery();
