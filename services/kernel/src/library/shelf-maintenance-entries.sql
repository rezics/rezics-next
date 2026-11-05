SELECT subject_id AS "subjectId",incarnation_id AS "incarnationId",transaction_id AS "transactionId",type_id AS "typeId"
 FROM library.entry WHERE route=:route::integer AND account_id=:account_id::uuid AND subject_id>:after::uuid ORDER BY subject_id LIMIT 1;
