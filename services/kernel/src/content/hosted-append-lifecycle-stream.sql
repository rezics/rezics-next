-- unbound: exact route/catalogue/stream is propagated through the modifying CTE
-- Capture high_water once from the self-base inventory, then keep decimal text
-- through every durable request/receipt. No dependent-descriptor prefix rescan.
WITH page AS MATERIALIZED (
  SELECT a.append_offset,a.occurrence_id,a.title_redacted
  FROM content.hosted_append a
  WHERE a.route=:route::integer AND a.catalogue_id=:catalogue_id::uuid
    AND a.stream_id=:stream_id::uuid
    AND a.append_offset>:after_offset::bigint AND a.append_offset<=:high_water::bigint
    AND EXISTS (
      SELECT 1 FROM content.hosted_append_descriptor d
      WHERE d.route=:route::integer AND d.catalogue_id=:catalogue_id::uuid
        AND d.revision_id=:stream_id::uuid AND d.base_revision_id=:stream_id::uuid
    )
  ORDER BY a.append_offset LIMIT 100
), changed AS (
  UPDATE content.hosted_append a SET title=NULL,title_redacted=true
  FROM page x
  WHERE a.route=:route::integer AND a.catalogue_id=:catalogue_id::uuid
    AND a.stream_id=:stream_id::uuid AND a.append_offset=x.append_offset
    AND NOT x.title_redacted
  RETURNING a.append_offset
)
SELECT x.append_offset::text,x.occurrence_id,c.append_offset IS NOT NULL AS changed
FROM page x LEFT JOIN changed c USING (append_offset)
ORDER BY x.append_offset;
