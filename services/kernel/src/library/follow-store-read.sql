SELECT route,
       account_id AS "accountId",
       target_id AS "targetId",
       target_type AS "targetType",
       state,
       reason,
       created_at::text AS "createdAt",
       updated_at::text AS "updatedAt",
       transaction_id AS "transactionId"
FROM library.follow
WHERE route = :route AND account_id = :account_id AND target_id = :target_id;
