SELECT route, account_id AS "accountId", kind, state, authn_fenced AS fenced,
       operator_account_id::text AS "operatorAccountId",
       minimum_authn_epoch::text AS "minimumAuthnEpoch",
       agent_verified AS "agentVerified", agent_subject_id::text AS "agentSubjectId",
       agent_verification_receipt_id::text AS "agentVerificationReceiptId",
       pending_agent_subject_id::text AS "pendingAgentSubjectId",
       pending_agent_receipt_id::text AS "pendingAgentReceiptId"
FROM access.account
WHERE route = :route::integer AND account_id = :account_id::uuid;
