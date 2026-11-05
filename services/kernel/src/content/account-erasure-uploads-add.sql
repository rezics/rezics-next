INSERT INTO content.account_upload (route, account_id, phase, id)
VALUES (:route::integer, :account_id::uuid, :phase::text, :id::uuid)
ON CONFLICT DO NOTHING;
