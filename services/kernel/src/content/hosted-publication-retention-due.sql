WITH input AS MATERIALIZED (
  SELECT :cutoff::timestamptz AS cutoff,
         :after_expires_at::timestamptz AS after_expires_at,
         :after_route::integer AS after_route,
         :after_catalogue_id::uuid AS after_catalogue_id,
         :after_stage_id::uuid AS after_stage_id,
         :row_limit::integer AS row_limit
), page AS MATERIALIZED (
  SELECT stage.route,stage.catalogue_id,stage.stage_id,stage.initiator_account_id,
         stage.owner_epoch::text,stage.source_revision_id,stage.expected_head_revision_id,
         stage.expected_publication_id,stage.mode,stage.source_kind,stage.status,stage.sealed_at,
         to_char(stage.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at
  FROM content.hosted_publication_staging stage
  CROSS JOIN input
  WHERE stage.expires_at<=input.cutoff
    AND (input.after_expires_at IS NULL OR
      ROW(stage.expires_at,stage.route,stage.catalogue_id,stage.stage_id)>
      ROW(input.after_expires_at,input.after_route,input.after_catalogue_id,input.after_stage_id))
  ORDER BY stage.expires_at,stage.route,stage.catalogue_id,stage.stage_id
  LIMIT (SELECT row_limit FROM input)
)
SELECT page.*,
       EXISTS (
         SELECT 1 FROM content.hosted_publication_staging_seal seal
         WHERE seal.route=page.route AND seal.catalogue_id=page.catalogue_id AND seal.stage_id=page.stage_id
       ) AS has_seal,
       (staging_cleanup.completed_at IS NOT NULL) AS staging_cleanup_completed,
       candidate.status AS candidate_status,
       candidate.mode AS candidate_mode,
       candidate.owner_epoch::text AS candidate_owner_epoch,
       COALESCE(candidate.generation_id,candidate_cleanup.generation_id) AS candidate_generation_id,
       (candidate_cleanup.completed_at IS NOT NULL) AS candidate_cleanup_completed
FROM page
LEFT JOIN content.hosted_publication_staging_cleanup staging_cleanup
  ON staging_cleanup.route=page.route AND staging_cleanup.catalogue_id=page.catalogue_id
 AND staging_cleanup.stage_id=page.stage_id
LEFT JOIN content.hosted_version_release_candidate candidate
  ON candidate.route=page.route AND candidate.catalogue_id=page.catalogue_id
 AND candidate.stage_id=page.stage_id
LEFT JOIN content.hosted_version_candidate_cleanup candidate_cleanup
  ON candidate_cleanup.route=page.route AND candidate_cleanup.catalogue_id=page.catalogue_id
 AND candidate_cleanup.stage_id=page.stage_id
ORDER BY page.expires_at,page.route,page.catalogue_id,page.stage_id;
