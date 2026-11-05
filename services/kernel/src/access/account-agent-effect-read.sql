WITH input AS (SELECT :route::integer AS route)
SELECT account.account_id::text AS "accountId", account.kind, account.state,
       account.handle, account.display_name AS "displayName",
       account.operator_account_id::text AS "operatorAccountId",
       account.authn_fenced AS fenced, account.agent_verified AS "agentVerified",
       account.pending_agent_receipt_id::text AS "pendingAgentReceiptId",
       CASE WHEN account.state = 'deleted' OR account.authn_fenced THEN (
         SELECT type FROM semantic.subject
         WHERE route = input.route AND subject_id = :agent_id::uuid
       ) END AS "agentType"
FROM input
JOIN access.account account ON account.route = input.route
WHERE account.account_id = :account_id::uuid;
