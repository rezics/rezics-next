WITH input AS MATERIALIZED (
  SELECT :cutoff::timestamptz AS cutoff,
         :after_available_at::timestamptz AS after_available_at,
         :after_route::integer AS after_route,
         :after_catalogue_id::uuid AS after_catalogue_id,
         :after_stage_id::uuid AS after_stage_id,
         :row_limit::integer AS row_limit
), page AS MATERIALIZED (
  SELECT pending.available_at,
         stage.route,stage.catalogue_id,stage.stage_id,stage.initiator_account_id,
         stage.owner_epoch::text,stage.source_revision_id,stage.expected_head_revision_id,
         stage.expected_publication_id,stage.mode,stage.source_kind,stage.status,stage.sealed_at,
         EXISTS (
           SELECT 1 FROM content.hosted_publication_staging_seal seal
           WHERE seal.route=stage.route AND seal.catalogue_id=stage.catalogue_id AND seal.stage_id=stage.stage_id
         ) AS has_seal,
         (staging_cleanup.completed_at IS NOT NULL) AS staging_cleanup_completed,
         candidate.status AS candidate_status,
         candidate.mode AS candidate_mode,
         candidate.owner_epoch::text AS candidate_owner_epoch,
         COALESCE(candidate.generation_id,candidate_cleanup.generation_id) AS candidate_generation_id,
         (candidate_cleanup.completed_at IS NOT NULL) AS candidate_cleanup_completed
  FROM content.hosted_publication_retention_pending pending
  JOIN content.hosted_publication_staging stage
    ON stage.route=pending.route AND stage.catalogue_id=pending.catalogue_id AND stage.stage_id=pending.stage_id
  CROSS JOIN input
  LEFT JOIN content.hosted_publication_staging_cleanup staging_cleanup
    ON staging_cleanup.route=stage.route AND staging_cleanup.catalogue_id=stage.catalogue_id
   AND staging_cleanup.stage_id=stage.stage_id
  LEFT JOIN content.hosted_version_release_candidate candidate
    ON candidate.route=stage.route AND candidate.catalogue_id=stage.catalogue_id
   AND candidate.stage_id=stage.stage_id
  LEFT JOIN content.hosted_version_candidate_cleanup candidate_cleanup
    ON candidate_cleanup.route=stage.route AND candidate_cleanup.catalogue_id=stage.catalogue_id
   AND candidate_cleanup.stage_id=stage.stage_id
  WHERE pending.available_at<=input.cutoff
    AND stage.expires_at<=input.cutoff
    AND (input.after_available_at IS NULL OR
      ROW(pending.available_at,pending.route,pending.catalogue_id,pending.stage_id)>
      ROW(input.after_available_at,input.after_route,input.after_catalogue_id,input.after_stage_id))
  ORDER BY pending.available_at,pending.route,pending.catalogue_id,pending.stage_id
  LIMIT (SELECT row_limit FROM input)
)
SELECT to_char(page.available_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS available_at,
       page.route,page.catalogue_id,page.stage_id,page.initiator_account_id,page.owner_epoch,
       page.source_revision_id,page.expected_head_revision_id,page.expected_publication_id,
       page.mode,page.source_kind,page.status,page.sealed_at,page.has_seal,
       page.staging_cleanup_completed,page.candidate_status,page.candidate_mode,
       page.candidate_owner_epoch,page.candidate_generation_id,page.candidate_cleanup_completed
FROM page
ORDER BY page.available_at,page.route,page.catalogue_id,page.stage_id;
