INSERT INTO content.authored_field
  (route, id, subject, anchor, candidate, revision, author_account_id, body, body_sha256, licence, language, availability)
VALUES
  (:route::integer, :id::uuid, :subject::uuid, :anchor::nullable(uuid), :candidate::uuid, :revision::bigint, :author_account_id::uuid,
   :body::bytea, :body_sha256::bytea, :licence::text, :language::text, 'available');
