SELECT account_id::text AS account, route, subject_id::text AS subject
FROM semantic.account_agent
WHERE account_id = :account_id::uuid;
