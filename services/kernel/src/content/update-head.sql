UPDATE content.post
SET head_revision_id = :revision_id::uuid,
    visibility = :visibility::text,
    security_revision = security_revision + CASE WHEN visibility <> :visibility::text THEN 1 ELSE 0 END
WHERE route = :route::integer AND thread_id = :thread_id::uuid AND post_id = :post_id::uuid
  AND author_account_id = :author_id::uuid AND availability = 'available'
  AND head_revision_id = :previous_revision_id::uuid
  AND visibility = :previous_visibility::text
  AND security_revision = :security_revision::bigint
  AND visibility <> 'taken_down'
RETURNING post_id;
