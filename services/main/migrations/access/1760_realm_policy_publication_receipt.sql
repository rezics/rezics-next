-- NULL retains the original receipt and request bytes for older deliveries.
-- Creation resolves its receipt through realm_creation_initialization; new
-- ordinary publications store the exact immutable graph receipt here.
ALTER TABLE access.realm_policy_delivery
  ADD COLUMN policy_head text CHECK (policy_head ~ '^urn:rezics:receipt:[0-9a-f]{64}$');
