WITH input AS MATERIALIZED (
  SELECT :route::integer AS route,
         :catalogue_id::uuid AS catalogue_id,
         :stage_id::uuid AS stage_id,
         :after_thread_id::uuid AS after_thread_id,
         :after_post_id::uuid AS after_post_id,
         :after_revision_id::uuid AS after_revision_id,
         :after_sha256::text AS after_sha256,
         :row_limit::integer AS row_limit
),
page AS MATERIALIZED (
  SELECT target.thread_id,target.post_id,target.target_revision_id,target.body_sha256
  FROM content.hosted_publication_staging_target target
  CROSS JOIN input
  WHERE target.route=input.route AND target.catalogue_id=input.catalogue_id
    AND target.stage_id=input.stage_id
    AND (
      input.after_thread_id IS NULL OR
      ROW(target.thread_id,target.post_id,target.target_revision_id,target.body_sha256) >
      ROW(input.after_thread_id,input.after_post_id,input.after_revision_id,
          decode(input.after_sha256,'hex'))
    )
  ORDER BY target.thread_id,target.post_id,target.target_revision_id,target.body_sha256
  LIMIT (SELECT row_limit FROM input)
)
DELETE FROM content.hosted_publication_staging_target target
USING page, input
WHERE target.route=input.route AND target.catalogue_id=input.catalogue_id
  AND target.stage_id=input.stage_id
  AND target.thread_id=page.thread_id AND target.post_id=page.post_id
  AND target.target_revision_id=page.target_revision_id
  AND target.body_sha256=page.body_sha256
RETURNING target.thread_id,target.post_id,target.target_revision_id,
          encode(target.body_sha256,'hex') AS body_sha256;
