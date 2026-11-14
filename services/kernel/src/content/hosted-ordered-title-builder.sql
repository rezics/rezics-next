WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :catalogue_id::uuid AS catalogue_id,
         :after_input::nullable(uuid) AS after_input,
         :after_ordinal::nullable(text)::bigint AS after_ordinal
), page AS MATERIALIZED (
  SELECT point.input_id,point.source_ordinal,point.title_redacted
  FROM input i CROSS JOIN LATERAL (
    SELECT input_id,source_ordinal,title_redacted FROM content.hosted_version_builder_point
    WHERE route=i.route AND catalogue_id=i.catalogue_id
      AND (input_id,source_ordinal)>(i.after_input,i.after_ordinal)
    ORDER BY route,catalogue_id,input_id,source_ordinal LIMIT 100
  ) point
  WHERE i.after_input IS NOT NULL
  UNION ALL
  SELECT point.input_id,point.source_ordinal,point.title_redacted
  FROM input i CROSS JOIN LATERAL (
    SELECT input_id,source_ordinal,title_redacted FROM content.hosted_version_builder_point
    WHERE route=i.route AND catalogue_id=i.catalogue_id
    ORDER BY route,catalogue_id,input_id,source_ordinal LIMIT 100
  ) point
  WHERE i.after_input IS NULL
), changed AS (
  UPDATE content.hosted_version_builder_point point SET title=NULL,title_redacted=true
  FROM page CROSS JOIN input i
  WHERE point.route=i.route AND point.catalogue_id=i.catalogue_id
    AND point.input_id=page.input_id AND point.source_ordinal=page.source_ordinal
    AND NOT page.title_redacted AND point.title IS NOT NULL
  RETURNING point.input_id,point.source_ordinal
)
SELECT page.input_id,page.source_ordinal::text AS source_ordinal,
       changed.input_id IS NOT NULL AS changed
FROM page LEFT JOIN changed USING(input_id,source_ordinal)
ORDER BY page.input_id,page.source_ordinal;
