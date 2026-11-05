WITH input AS NOT MATERIALIZED (SELECT :time::nullable(timestamptz) AS time)
SELECT route, account_id AS "accountId", subject_id AS "subjectId", label_id AS "labelId",
       assignment_id AS id, revision, slot_no AS "slotNo",
       created_at::text AS "createdAt", updated_at::text AS "updatedAt",
       deleted_at::text AS "deletedAt", purge_after::text AS "purgeAfter",
       transaction_id AS "transactionId",
       assignment_id = :assignment_id::nullable(uuid) AS "identityMatches",
       deleted_at <= input.time AS started,
       input.time >= purge_after AS expired
FROM library.label_assignment CROSS JOIN input
WHERE route = :route AND account_id = :account_id AND subject_id = :subject_id AND label_id = :label_id;
