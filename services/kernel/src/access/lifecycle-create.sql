INSERT INTO access.account (route, account_id, kind, handle, state, registration_id, registration_expires_at, transaction_id)
VALUES (:route, :account_id, :kind, NULLIF(:handle::text, ''), :state, NULLIF(:registration_id::text, '')::uuid, NULLIF(:expires_at::text, '')::timestamptz, :transaction_id)
RETURNING account_id;
