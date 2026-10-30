-- Both mutually exclusive raw branches are owner-indexed before LIMIT; no zero-UUID sentinel omission.
(SELECT subject_id::text AS key,''::text AS tie,subject_id::text AS "subjectId",transaction_id::text AS "transactionId"
FROM library.entry WHERE route=:account_route AND account_id=:account_id AND :after::nullable(uuid) IS NULL
ORDER BY subject_id LIMIT :limit)
UNION ALL
(SELECT subject_id::text AS key,''::text AS tie,subject_id::text AS "subjectId",transaction_id::text AS "transactionId"
FROM library.entry WHERE route=:account_route AND account_id=:account_id AND :after::nullable(uuid) IS NOT NULL
AND subject_id>:after::nullable(uuid)
ORDER BY subject_id LIMIT :limit);
