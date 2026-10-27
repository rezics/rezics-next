UPDATE access.account
SET pending_agent_subject_id = NULL, pending_agent_receipt_id = NULL,
    transaction_id = :transaction_id::uuid
WHERE route = :route::integer AND account_id = :account_id::uuid
  AND pending_agent_subject_id = :catalogue_subject_id::uuid
  AND pending_agent_receipt_id = :receipt_id::uuid
RETURNING account_id::text AS "accountId";
