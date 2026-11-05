-- migrate:up
-- Buyer-home serialization, full bounded native key equality (never a digest-only lock).
CREATE TABLE commerce.benefit_acquisition (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  buyer_account_id uuid NOT NULL,
  benefit jsonb NOT NULL CHECK (octet_length(benefit::text) <= 1024),
  slot_id uuid NOT NULL,
  order_id uuid NOT NULL,
  PRIMARY KEY (route, buyer_account_id, benefit),
  CHECK (route = get_byte(uuid_send(buyer_account_id), 10) * 256 + get_byte(uuid_send(buyer_account_id), 11)),
  CHECK (route = get_byte(uuid_send(slot_id), 10) * 256 + get_byte(uuid_send(slot_id), 11)),
  CHECK (route = get_byte(uuid_send(order_id), 10) * 256 + get_byte(uuid_send(order_id), 11))
);
CREATE UNIQUE INDEX benefit_acquisition_account_page ON commerce.benefit_acquisition (route, buyer_account_id, slot_id);

-- NULL includes every old mapped order: historical failure/age is not verified release.
ALTER TABLE commerce.purchase_order ADD COLUMN acquisition_release text
  CHECK (acquisition_release IN ('no-creation', 'cancelled-no-charge', 'refunded', 'lost-dispute'));
CREATE INDEX purchase_order_benefit_unresolved ON commerce.purchase_order
  (route, buyer_account_id, (content_edition->'benefit'), order_id)
  WHERE content_edition IS NOT NULL AND acquisition_release IS NULL;
CREATE INDEX entitlement_benefit_active ON commerce.entitlement
  (route, account_id, (content_edition->'benefit'), entitlement_id)
  WHERE content_edition IS NOT NULL AND revoked_at IS NULL AND revoke_reason IS NULL;

-- migrate:down
DROP INDEX commerce.entitlement_benefit_active;
DROP INDEX commerce.purchase_order_benefit_unresolved;
ALTER TABLE commerce.purchase_order DROP COLUMN acquisition_release;
DROP TABLE commerce.benefit_acquisition;
