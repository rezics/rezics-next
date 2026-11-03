WITH input AS NOT MATERIALIZED (SELECT :visibility::text AS visibility)
UPDATE content.post p
SET draft_locator_pending=true, head_revision_id = :revision_id::uuid,
    visibility = input.visibility,
    security_revision = p.security_revision + CASE WHEN p.visibility <> input.visibility THEN 1 ELSE 0 END
FROM input
WHERE route = :route::integer AND thread_id = :thread_id::uuid AND post_id = :post_id::uuid
  AND author_account_id = :author_id::uuid AND availability = 'available'
  AND head_revision_id = :previous_revision_id::uuid
  AND p.visibility = :previous_visibility::text
  AND security_revision = :security_revision::bigint
  AND p.visibility <> 'taken_down'
RETURNING post_id;
