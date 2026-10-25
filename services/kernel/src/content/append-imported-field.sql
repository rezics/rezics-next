INSERT INTO content.imported_field
  (route, id, subject, candidate, revision, body, body_sha256, source, rights, language, availability)
VALUES
  (:route::integer, :id::uuid, :subject::uuid, :candidate::uuid, :revision::bigint, :body::bytea, :body_sha256::bytea,
   :source::jsonb, :rights::jsonb, :language::text, 'available');
