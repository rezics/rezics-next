-- One buyer-home lookup by the stable routed Post/action benefit.
-- No revision selector is stored or joined, so later eligible Post revisions reuse this entitlement.
SELECT route, entitlement_id AS id, account_id AS "accountId", order_id AS "orderId", offer_id AS "offerId",
       target_subject_id AS "targetSubjectId", granted_at::text AS "grantedAt", revoked_at::text AS "revokedAt",
       revoke_reason AS "revokeReason", revision, content_post::text AS "contentPost"
FROM commerce.entitlement
WHERE route = :route AND account_id = :account_id
  AND content_post IS NOT NULL AND revoked_at IS NULL AND revoke_reason IS NULL
  AND content_post->'benefit' = :benefit::text::jsonb
  AND content_post->'benefit'->>'kind' = 'content-post'
  AND content_post->'benefit'->>'resourceType' = 'content.post'
  AND content_post->'benefit'->>'action' = 'post:read'
  AND content_post->'benefit'->'resource'->>'route' = :post_route
  AND content_post->'benefit'->'resource'->>'id' = :post_id
ORDER BY entitlement_id LIMIT 2;
