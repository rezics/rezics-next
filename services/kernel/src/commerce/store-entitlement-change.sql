UPDATE commerce.entitlement SET revoked_at = NULLIF(:revoked_at::text, '')::timestamptz, revoke_reason = NULLIF(:revoke_reason::text, ''),
revision = revision + 1, transaction_id = :transaction_id
WHERE route = :route AND entitlement_id = :id AND revision = :revision RETURNING entitlement_id AS id, account_id AS "accountId", order_id AS "orderId", offer_id AS "offerId",
       target_subject_id AS "targetSubjectId", content_edition::text AS "contentEdition", granted_at::text AS "grantedAt", revoked_at::text AS "revokedAt",
       revoke_reason AS "revokeReason", revision;
