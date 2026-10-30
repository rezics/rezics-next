SELECT change_no::text AS key,session_id::text AS tie,NULL::text AS "subjectId",transaction_id::text AS "transactionId"
FROM library.progress_change WHERE route=:account_route AND session_id=:session_id AND change_no>:after::integer
ORDER BY change_no LIMIT :limit;
