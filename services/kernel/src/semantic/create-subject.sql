INSERT INTO semantic.subject (route, subject_id, type, recorded_transaction_id, current_facts, current_release)
VALUES (:route::integer, :subject_id::uuid, :type::text, :transaction_id::uuid,
        :current_facts::integer, :current_release::text);
