SELECT entitlement_id AS id, account_id AS "accountId", order_id AS "orderId", offer_id AS "offerId",
       target_subject_id AS "targetSubjectId", content_edition::text AS "contentEdition", granted_at::text AS "grantedAt", revoked_at::text AS "revokedAt",
       revoke_reason AS "revokeReason", revision FROM commerce.entitlement
WHERE route = :route AND account_id = :account_id AND entitlement_id < :after::uuid
ORDER BY entitlement_id DESC LIMIT :limit;
