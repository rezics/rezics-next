WITH input AS MATERIALIZED (
  SELECT :after_route::integer AS after_route,
         :after_catalogue_id::uuid AS after_catalogue_id,
         :after_stage_id::uuid AS after_stage_id,
         :row_limit::integer AS row_limit
), page AS MATERIALIZED (
  SELECT stage.route,stage.catalogue_id,stage.stage_id,stage.expires_at,
         (staging_cleanup.completed_at IS NOT NULL OR candidate_cleanup.completed_at IS NOT NULL) AS completed
  FROM content.hosted_publication_staging stage
  CROSS JOIN input
  LEFT JOIN content.hosted_publication_staging_cleanup staging_cleanup
    ON staging_cleanup.route=stage.route AND staging_cleanup.catalogue_id=stage.catalogue_id
   AND staging_cleanup.stage_id=stage.stage_id
  LEFT JOIN content.hosted_version_candidate_cleanup candidate_cleanup
    ON candidate_cleanup.route=stage.route AND candidate_cleanup.catalogue_id=stage.catalogue_id
   AND candidate_cleanup.stage_id=stage.stage_id
  WHERE input.after_route IS NULL OR
    ROW(stage.route,stage.catalogue_id,stage.stage_id)>
    ROW(input.after_route,input.after_catalogue_id,input.after_stage_id)
  ORDER BY stage.route,stage.catalogue_id,stage.stage_id
  LIMIT (SELECT row_limit FROM input)
), inserted AS (
  INSERT INTO content.hosted_publication_retention_pending
    (route,catalogue_id,stage_id,available_at)
  SELECT route,catalogue_id,stage_id,expires_at
  FROM page
  WHERE NOT completed
  ON CONFLICT (route,catalogue_id,stage_id) DO NOTHING
  RETURNING 1
), last_key AS (
  SELECT route,catalogue_id,stage_id
  FROM page
  ORDER BY route DESC,catalogue_id DESC,stage_id DESC
  LIMIT 1
), advanced AS (
  UPDATE content.hosted_publication_retention_adoption_cursor
  SET after_route=(SELECT route FROM last_key),
      after_catalogue_id=(SELECT catalogue_id FROM last_key),
      after_stage_id=(SELECT stage_id FROM last_key),
      complete=((SELECT count(*) FROM page)<(SELECT row_limit FROM input)),
      updated_at=clock_timestamp()
  WHERE singleton=true
  RETURNING complete
)
SELECT (SELECT count(*)::integer FROM page) AS examined,
       (SELECT count(*)::integer FROM inserted) AS adopted,
       (SELECT complete FROM advanced) AS complete;
