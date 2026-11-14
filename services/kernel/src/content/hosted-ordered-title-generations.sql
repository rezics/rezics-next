WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :catalogue_id::uuid AS catalogue_id,
         :after_generation::nullable(uuid) AS after_generation
), page AS MATERIALIZED (
  SELECT generation.generation_id
  FROM input i CROSS JOIN LATERAL (
    SELECT generation_id FROM content.hosted_tree_generation
    WHERE route=i.route AND catalogue_id=i.catalogue_id
      AND generation_id>i.after_generation
    ORDER BY route,catalogue_id,generation_id LIMIT 100
  ) generation
  WHERE i.after_generation IS NOT NULL
  UNION ALL
  SELECT generation.generation_id
  FROM input i CROSS JOIN LATERAL (
    SELECT generation_id FROM content.hosted_tree_generation
    WHERE route=i.route AND catalogue_id=i.catalogue_id
    ORDER BY route,catalogue_id,generation_id LIMIT 100
  ) generation
  WHERE i.after_generation IS NULL
)
SELECT page.generation_id,
       EXISTS (
         SELECT 1 FROM content.hosted_version_revision revision
         WHERE revision.route=i.route AND revision.catalogue_id=i.catalogue_id
           AND revision.generation_id=page.generation_id AND revision.revision_kind='publication'
         LIMIT 1
       ) AS retained_public
FROM page CROSS JOIN input i
ORDER BY page.generation_id;
