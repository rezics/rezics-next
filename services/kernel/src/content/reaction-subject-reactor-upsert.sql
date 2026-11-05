INSERT INTO content.subject_reactor AS reactor (route, subject_id, actor_account_id, kind)
VALUES (:route::integer, :subject_id::uuid, :actor_account_id::uuid, :kind::text)
ON CONFLICT (route, subject_id, actor_account_id) DO UPDATE
SET kind = EXCLUDED.kind;
