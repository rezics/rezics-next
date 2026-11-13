-- unbound: exact route/catalogue/stream is propagated through the modifying CTE
-- Capture high_water once from the self-base inventory, then keep decimal text
-- through every durable request/receipt. No dependent-descriptor prefix rescan.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :catalogue_id::uuid AS catalogue_id,
         :stream_id::uuid AS stream_id, :after_offset::bigint AS after_offset, :high_water::bigint AS high_water
), page AS MATERIALIZED (
  SELECT a.append_offset,a.occurrence_id,a.title_redacted
  FROM content.hosted_append a CROSS JOIN input i
  WHERE a.route=i.route AND a.catalogue_id=i.catalogue_id AND a.stream_id=i.stream_id
    AND a.append_offset>i.after_offset AND a.append_offset<=i.high_water
    AND EXISTS (
      SELECT 1 FROM content.hosted_append_descriptor d
      WHERE d.route=i.route AND d.catalogue_id=i.catalogue_id
        AND d.revision_id=i.stream_id AND d.base_revision_id=i.stream_id
    )
  ORDER BY a.append_offset LIMIT 100
), changed AS (
  UPDATE content.hosted_append a SET title=NULL,title_redacted=true
  FROM page x CROSS JOIN input i
  WHERE a.route=i.route AND a.catalogue_id=i.catalogue_id
    AND a.stream_id=i.stream_id AND a.append_offset=x.append_offset
    AND NOT x.title_redacted
  RETURNING a.append_offset
)
SELECT x.append_offset::text,x.occurrence_id,c.append_offset IS NOT NULL AS changed
FROM page x LEFT JOIN changed c USING (append_offset)
ORDER BY x.append_offset;
