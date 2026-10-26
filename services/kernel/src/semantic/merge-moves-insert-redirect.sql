INSERT INTO semantic.redirect (route, subject_id, sequence, target, recorded_transaction_id)
VALUES (:route::integer, :subject_id::uuid, :sequence::integer, :target::uuid, :transaction_id::uuid);
