-- Both mutually exclusive raw branches are owner-indexed before LIMIT; no zero-UUID sentinel omission.
(SELECT label_id::text AS key,''::text AS tie,NULL::text AS "subjectId",transaction_id::text AS "transactionId"
FROM library.personal_label WHERE route=:account_route AND account_id=:account_id AND :after::nullable(uuid) IS NULL
ORDER BY label_id LIMIT :limit)
UNION ALL
(SELECT label_id::text AS key,''::text AS tie,NULL::text AS "subjectId",transaction_id::text AS "transactionId"
FROM library.personal_label WHERE route=:account_route AND account_id=:account_id AND :after::nullable(uuid) IS NOT NULL
AND label_id>:after::nullable(uuid)
ORDER BY label_id LIMIT :limit);
