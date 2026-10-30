-- Both mutually exclusive raw branches are owner-indexed before LIMIT; no zero-UUID sentinel omission.
(SELECT session_id::text AS key,''::text AS tie,subject_id::text AS "subjectId",transaction_id::text AS "transactionId"
FROM library.progress_session WHERE route=:account_route AND account_id=:account_id AND :after::nullable(uuid) IS NULL
ORDER BY session_id LIMIT 1)
UNION ALL
(SELECT session_id::text AS key,''::text AS tie,subject_id::text AS "subjectId",transaction_id::text AS "transactionId"
FROM library.progress_session WHERE route=:account_route AND account_id=:account_id AND :after::nullable(uuid) IS NOT NULL
AND session_id>:after::nullable(uuid)
ORDER BY session_id LIMIT 1);
