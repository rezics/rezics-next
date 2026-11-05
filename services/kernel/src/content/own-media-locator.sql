INSERT INTO content.account_upload (route, account_id, phase, id)
VALUES (:route::integer, :account_id::uuid, 'media', :id::uuid)
ON CONFLICT DO NOTHING;
