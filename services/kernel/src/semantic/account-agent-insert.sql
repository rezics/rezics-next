INSERT INTO semantic.account_agent (account_id, route, subject_id)
VALUES (:account_id::uuid, :route::integer, :subject_id::uuid)
ON CONFLICT (account_id) DO NOTHING
RETURNING account_id::text AS account, route, subject_id::text AS subject;
