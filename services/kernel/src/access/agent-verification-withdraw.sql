WITH candidate AS (
  SELECT request_id
  FROM access.agent_verification_request
  WHERE route = 0 AND account_id = :account_id::uuid AND state = 'pending'
  ORDER BY created_at DESC, request_id DESC
  LIMIT 1
  FOR UPDATE
)
UPDATE access.agent_verification_request AS request
SET state = 'withdrawn', updated_at = statement_timestamp(), transaction_id = :transaction_id::uuid
FROM candidate
WHERE request.route = 0 AND request.request_id = candidate.request_id AND request.state = 'pending'
RETURNING request.request_id::text AS id, request.account_id::text AS "accountId",
          request.account_kind AS "accountKind", request.requested_by::text AS "requestedBy",
          request.catalogue_subject_id::text AS "catalogueSubjectId", request.statement, request.links,
          request.state, request.reason, request.problem_type AS "problemType",
          request.problem_detail AS "problemDetail", request.decision_receipt_id::text AS "decisionReceiptId",
          request.decided_by::text AS "decidedBy",
          request.created_at::text AS "createdAt", request.updated_at::text AS "updatedAt";
