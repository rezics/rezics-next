-- Both mutually exclusive raw branches are owner-indexed before LIMIT; no zero-UUID sentinel omission.
(SELECT subject_id::text AS key,label_id::text AS tie,subject_id::text AS "subjectId",transaction_id::text AS "transactionId"
FROM library.label_assignment WHERE route=:account_route AND account_id=:account_id AND :after::nullable(uuid) IS NULL
ORDER BY subject_id,label_id LIMIT :limit)
UNION ALL
(SELECT subject_id::text AS key,label_id::text AS tie,subject_id::text AS "subjectId",transaction_id::text AS "transactionId"
FROM library.label_assignment WHERE route=:account_route AND account_id=:account_id AND :after::nullable(uuid) IS NOT NULL
AND (subject_id,label_id)>(:after::nullable(uuid),:tie::uuid)
ORDER BY subject_id,label_id LIMIT :limit);
