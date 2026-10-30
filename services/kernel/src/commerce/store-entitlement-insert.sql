INSERT INTO commerce.entitlement
(route, entitlement_id, account_id, order_id, offer_id, target_subject_id, content_edition, granted_at, revision, transaction_id)
VALUES (:route, :id, :account_id, :order_id, :offer_id, :target_subject_id, NULLIF(:content_edition::text, '')::jsonb, :time, 1, :transaction_id)
RETURNING entitlement_id AS id, account_id AS "accountId", order_id AS "orderId", offer_id AS "offerId",
       target_subject_id AS "targetSubjectId", content_edition::text AS "contentEdition", granted_at::text AS "grantedAt", revoked_at::text AS "revokedAt",
       revoke_reason AS "revokeReason", revision;
