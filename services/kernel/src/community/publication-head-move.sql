UPDATE community.publication_head
SET publication_id = :publication::uuid, verdict = :verdict::text, published_at = :at::timestamptz
WHERE route = :route::integer AND realm_id = :realm::uuid AND subject_id = :subject::uuid
  AND publication_id = :expected::uuid
RETURNING publication_id;
