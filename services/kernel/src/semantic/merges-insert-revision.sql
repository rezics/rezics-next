INSERT INTO semantic.revision (route, subject_id, revision, kind, release, recorded_transaction_id)
VALUES (:route::integer, :subject_id::uuid, :revision::integer, 'merge', :release::text, :transaction_id::uuid);
