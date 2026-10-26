SELECT account_id::text AS account, route, subject_id::text AS subject,
       agent_id::text AS agent_id, verified, receipt_id
FROM semantic.account_agent
WHERE route = :route::integer AND account_id = :account_id::uuid;
