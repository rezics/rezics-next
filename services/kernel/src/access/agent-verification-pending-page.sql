SELECT request_id::text AS id, account_id::text AS "accountId", account_kind AS "accountKind",
       requested_by::text AS "requestedBy", catalogue_subject_id::text AS "catalogueSubjectId",
       statement, links, state, reason, problem_type AS "problemType", problem_detail AS "problemDetail",
       decision_receipt_id::text AS "decisionReceiptId", decided_by::text AS "decidedBy",
       created_at::text AS "createdAt", updated_at::text AS "updatedAt"
FROM access.agent_verification_request
WHERE route = 0 AND state = 'pending'
  AND (created_at, request_id) > (:after_created::timestamptz, :after_request_id::uuid)
ORDER BY created_at, request_id
LIMIT :limit::integer;
