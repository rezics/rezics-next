UPDATE content.thread
SET visibility = 'published', security_revision = security_revision + 1
WHERE route = :route::integer AND thread_id = :thread_id::uuid
  AND first_post_id = :post_id::uuid AND author_account_id = :author_id::uuid
  AND visibility = 'draft' AND availability = 'available'
  AND security_revision = :security_revision::bigint
RETURNING thread_id;
