INSERT INTO semantic.redirect (route, subject_id, sequence, target, recorded_transaction_id)
VALUES (:route::integer, :subject_id::uuid, 1, :target::uuid, :transaction_id::uuid);
