INSERT INTO semantic.subject (route, subject_id, type, recorded_transaction_id)
VALUES (:route::integer, :subject_id::uuid, 'schema:Book', :transaction_id::uuid);
