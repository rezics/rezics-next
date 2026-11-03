SELECT revision, incarnation_id AS "incarnationId", transaction_id AS "transactionId",
       state, library_profile_pin AS "libraryProfilePin"
FROM library.entry
WHERE route = :route AND account_id = :account_id AND subject_id = :subject_id
FOR UPDATE;
