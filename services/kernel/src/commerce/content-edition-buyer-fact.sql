-- One buyer-home exact composite seek, including every immutable benefit operand.
-- Two rows detect ambiguity without scanning purchase history or loading orders.
SELECT route, entitlement_id AS id, account_id AS "accountId", order_id AS "orderId", offer_id AS "offerId",
       target_subject_id AS "targetSubjectId", granted_at::text AS "grantedAt", revoked_at::text AS "revokedAt",
       revoke_reason AS "revokeReason", revision, content_edition::text AS "contentEdition"
FROM commerce.entitlement
WHERE route = :route AND account_id = :account_id
  AND content_edition IS NOT NULL AND revoked_at IS NULL AND revoke_reason IS NULL
  AND content_edition->'benefit'->>'kind' = 'content-edition'
  AND content_edition->'benefit'->>'resourceType' = 'content.edition'
  AND content_edition->'benefit'->>'action' = 'edition:read'
  AND content_edition->'benefit'->'resource'->>'route' = :edition_route
  AND content_edition->'benefit'->'resource'->>'id' = :edition_id
  AND content_edition->'benefit'->'version'->>'revisionId' = :revision_id
  AND content_edition->'benefit'->'version'->>'sha256' = :sha256
ORDER BY entitlement_id LIMIT 2;
