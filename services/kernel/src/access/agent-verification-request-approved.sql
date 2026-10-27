UPDATE access.agent_verification_request
SET state = 'approved', updated_at = statement_timestamp(), transaction_id = :transaction_id::uuid
WHERE route = 0 AND request_id = :request_id::uuid AND state = 'approving'
  AND decision_receipt_id = :receipt_id::uuid
RETURNING request_id::text AS id;
