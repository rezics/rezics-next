UPDATE access.account
SET pending_agent_subject_id = :catalogue_subject_id::uuid,
    pending_agent_receipt_id = :receipt_id::uuid,
    transaction_id = :transaction_id::uuid
WHERE route = :route::integer AND account_id = :account_id::uuid
  AND state = 'active' AND NOT authn_fenced AND kind = :account_kind::text
  AND NOT agent_verified AND agent_subject_id IS NULL
  AND pending_agent_subject_id IS NULL AND pending_agent_receipt_id IS NULL
RETURNING account_id::text AS "accountId";
