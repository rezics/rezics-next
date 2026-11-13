WITH page AS MATERIALIZED (
  SELECT thread_id,post_id,target_revision_id,body_sha256
  FROM content.hosted_publication_staging_target
  WHERE route=:route::integer AND catalogue_id=:catalogue_id::uuid
    AND stage_id=:stage_id::uuid
    AND (:after_thread_id::uuid IS NULL OR
      ROW(thread_id,post_id,target_revision_id,body_sha256) >
      ROW(:after_thread_id::uuid,:after_post_id::uuid,:after_revision_id::uuid,
          decode(:after_sha256::text,'hex')))
  ORDER BY thread_id,post_id,target_revision_id,body_sha256
  LIMIT :row_limit::integer
)
DELETE FROM content.hosted_publication_staging_target target
USING page
WHERE target.route=:route::integer AND target.catalogue_id=:catalogue_id::uuid
  AND target.stage_id=:stage_id::uuid
  AND target.thread_id=page.thread_id AND target.post_id=page.post_id
  AND target.target_revision_id=page.target_revision_id AND target.body_sha256=page.body_sha256
RETURNING target.thread_id,target.post_id,target.target_revision_id,
          encode(target.body_sha256,'hex') AS body_sha256;
