INSERT INTO community.publication
  (route, publication_id, realm_id, subject_id, verdict, predecessor, subject_revision_id, actor, created_at)
VALUES (:route::integer, :publication::uuid, :realm::uuid, :subject::uuid, :verdict::text,
        :predecessor::nullable(uuid), NULL, :actor::uuid, :at::timestamptz);
