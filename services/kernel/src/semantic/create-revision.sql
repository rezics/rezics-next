INSERT INTO semantic.revision (route, subject_id, revision, kind, release, recorded_transaction_id, source)
VALUES (:route::integer, :subject_id::uuid, 1, 'create', :release::text, :transaction_id::uuid, :source::jsonb);
