INSERT INTO access.agent_verification_request (
  route, request_id, account_id, account_kind, requested_by, catalogue_subject_id,
  statement, links, state, transaction_id
)
VALUES (
  0, :request_id::uuid, :account_id::uuid, :account_kind::text, :requested_by::uuid,
  :catalogue_subject_id::uuid, :statement::text, :links::jsonb, 'pending', :transaction_id::uuid
)
RETURNING request_id::text AS id, account_id::text AS "accountId", account_kind AS "accountKind",
          requested_by::text AS "requestedBy", catalogue_subject_id::text AS "catalogueSubjectId",
          statement, links, state, reason, problem_type AS "problemType", problem_detail AS "problemDetail",
          decision_receipt_id::text AS "decisionReceiptId", decided_by::text AS "decidedBy",
          created_at::text AS "createdAt", updated_at::text AS "updatedAt";
