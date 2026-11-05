UPDATE content.post p SET availability = 'available', deleted_at = NULL,
  security_revision = security_revision + 1
WHERE p.route = :route::integer AND p.post_id = :post_id::uuid
  AND p.author_account_id = :author_id::uuid AND p.availability = 'erased'
  AND p.deleted_at > :at::timestamptz - interval '30 days'
  AND p.purge_started_at IS NULL AND NOT p.purge_completed
  AND EXISTS (SELECT 1 FROM content.revision r WHERE r.route = p.route
    AND r.post_id = p.post_id AND r.revision_id = p.head_revision_id
    AND r.availability = 'available')
RETURNING p.thread_id, p.security_revision::text;
