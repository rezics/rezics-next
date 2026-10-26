INSERT INTO semantic.external_claim (route, source, external_id, subject_id, recorded_transaction_id)
VALUES (:route::integer, :source::text, :external_id::text, :subject_id::uuid, :transaction_id::uuid);
