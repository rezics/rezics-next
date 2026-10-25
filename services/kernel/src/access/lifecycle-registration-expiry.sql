INSERT INTO access.lifecycle_registration_expiry (route, account_id, reservation_id, handle, transaction_id)
VALUES (:route, :account_id, :reservation_id, :handle, :transaction_id)
RETURNING account_id;
