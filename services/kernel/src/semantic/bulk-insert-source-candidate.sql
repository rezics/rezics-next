INSERT INTO semantic.source_candidate
(route, subject_id, source, external_id, field_group, statement_digest, candidate_id)
VALUES (:route::integer, :subject_id::uuid, :source::text, :external_id::text, :field_group::text,
        :statement_digest::text, :candidate_id::uuid);
