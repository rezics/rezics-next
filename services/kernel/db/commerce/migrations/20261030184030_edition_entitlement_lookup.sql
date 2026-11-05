-- migrate:up
-- Exact current buyer + immutable edition tuple; historic/revoked purchases do not enter this range.
CREATE INDEX entitlement_edition_buyer_lookup ON commerce.entitlement (
  route, account_id,
  (content_edition->'benefit'->>'kind'),
  (content_edition->'benefit'->>'resourceType'),
  (content_edition->'benefit'->>'action'),
  (content_edition->'benefit'->'resource'->>'route'),
  (content_edition->'benefit'->'resource'->>'id'),
  (content_edition->'benefit'->'version'->>'revisionId'),
  (content_edition->'benefit'->'version'->>'sha256'), entitlement_id
) WHERE content_edition IS NOT NULL AND revoked_at IS NULL AND revoke_reason IS NULL;

-- migrate:down
DROP INDEX commerce.entitlement_edition_buyer_lookup;
