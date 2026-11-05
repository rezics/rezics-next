WITH previous AS MATERIALIZED (
  SELECT route, account_id, agent_subject_id, agent_verification_receipt_id
  FROM access.account
  WHERE route = :route::integer AND account_id = :account_id::uuid AND agent_verified
  FOR UPDATE
)
UPDATE access.account AS account
SET agent_verified = false, agent_subject_id = NULL, agent_verification_receipt_id = NULL,
    pending_agent_subject_id = previous.agent_subject_id,
    pending_agent_receipt_id = :receipt_id::uuid, transaction_id = :transaction_id::uuid
FROM previous
WHERE account.route = previous.route AND account.account_id = previous.account_id
RETURNING previous.agent_subject_id::text AS "catalogueSubjectId",
          previous.agent_verification_receipt_id::text AS "verificationReceiptId";
