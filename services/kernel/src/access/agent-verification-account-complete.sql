WITH input AS (
  SELECT :catalogue_subject_id::uuid AS catalogue_subject_id, :receipt_id::uuid AS receipt_id
)
UPDATE access.account AS account
SET agent_verified = true,
    agent_subject_id = input.catalogue_subject_id,
    agent_verification_receipt_id = input.receipt_id,
    pending_agent_subject_id = NULL,
    pending_agent_receipt_id = NULL,
    transaction_id = :transaction_id::uuid
FROM input
WHERE route = :route::integer AND account_id = :account_id::uuid
  AND (
    (account.pending_agent_subject_id = input.catalogue_subject_id AND account.pending_agent_receipt_id = input.receipt_id)
    OR
    (account.agent_verified AND account.agent_subject_id = input.catalogue_subject_id
      AND account.agent_verification_receipt_id = input.receipt_id)
  )
RETURNING account.account_id::text AS "accountId";
