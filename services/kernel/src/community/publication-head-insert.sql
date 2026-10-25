INSERT INTO community.publication_head
  (route, realm_id, subject_id, publication_id, verdict, published_at)
VALUES (:route::integer, :realm::uuid, :subject::uuid, :publication::uuid, :verdict::text, :at::timestamptz)
ON CONFLICT (route, realm_id, subject_id) DO NOTHING
RETURNING publication_id;
