INSERT INTO semantic.subject (route, subject_id, type, recorded_transaction_id)
VALUES (:route::integer, :subject_id::uuid, :type::text, :transaction_id::uuid);
