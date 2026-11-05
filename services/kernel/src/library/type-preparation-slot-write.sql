INSERT INTO library.type_preparation_slot(route, account_id, binding_digest, preparation_id)
VALUES (:route::integer, :account_id::uuid, :binding_digest::text, :preparation_id::uuid)
ON CONFLICT (route, account_id, binding_digest) DO UPDATE SET preparation_id = EXCLUDED.preparation_id;
