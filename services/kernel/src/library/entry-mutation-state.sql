SELECT revision, incarnation_id AS "incarnationId", transaction_id AS "transactionId"
FROM library.entry
WHERE route = :route AND account_id = :account_id AND subject_id = :subject_id
FOR UPDATE;
