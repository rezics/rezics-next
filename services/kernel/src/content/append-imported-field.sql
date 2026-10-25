INSERT INTO content.imported_field
  (route, id, subject, body, body_sha256, source, rights, language, availability)
VALUES
  (:route::integer, :id::uuid, :subject::uuid, :body::bytea, :body_sha256::bytea,
   :source::jsonb, :rights::jsonb, :language::text, 'available');
