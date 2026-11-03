SELECT p.thread_id::text, p.author_account_id::text AS actor_id, t.first_post_id::text
FROM content.post AS p
JOIN content.thread AS t ON t.route = p.route AND t.thread_id = p.thread_id
JOIN content.revision AS r ON r.route = p.route AND r.thread_id = p.thread_id
  AND r.post_id = p.post_id AND r.revision_id = :revision_id::uuid AND r.availability = 'available'
WHERE p.route = :route::integer
  AND p.thread_id = :thread_id::uuid
  AND p.post_id = :post_id::uuid
  AND p.author_account_id = :actor_id::uuid
  AND p.post_id <> t.first_post_id
  AND p.visibility = 'published'
  AND p.availability = 'available'
  AND t.visibility IN ('published', 'protected')
  AND t.availability = 'available';
