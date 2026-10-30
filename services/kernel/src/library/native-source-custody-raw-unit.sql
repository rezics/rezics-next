SELECT unit_id AS key,session_id::text AS tie,NULL::text AS "subjectId",NULL::text AS "transactionId"
FROM library.progress_unit WHERE route=:account_route AND session_id=:session_id AND unit_id>:after::text
ORDER BY unit_id LIMIT :limit;
