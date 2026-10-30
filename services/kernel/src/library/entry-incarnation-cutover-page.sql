SELECT route, account_id AS "accountId", subject_id AS "subjectId", revision,
       transaction_id AS "transactionId", xmin::text AS version, incarnation_id AS "incarnationId"
FROM library.entry
WHERE route >= :start_route::integer AND route < :end_route::integer
  AND (route, account_id, subject_id) > (:after_route::integer, :after_account_id::uuid, :after_subject_id::uuid)
ORDER BY route, account_id, subject_id
LIMIT :limit::integer;
