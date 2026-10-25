UPDATE content.post
SET head_revision_id = :revision_id::uuid
WHERE route = :route::integer AND thread_id = :thread_id::uuid AND post_id = :post_id::uuid
  AND author_account_id = :author_id::uuid AND availability = 'available'
  AND head_revision_id = :previous_revision_id::uuid
RETURNING post_id;
