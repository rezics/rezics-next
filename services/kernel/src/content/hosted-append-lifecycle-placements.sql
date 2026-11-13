-- unbound: exact route/catalogue/revision is propagated through the modifying CTE
-- Include already redacted candidates so a repeated range has the same frontier.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :catalogue_id::uuid AS catalogue_id,
         :revision_id::uuid AS revision_id, :after_occurrence::uuid AS after_occurrence
), page AS MATERIALIZED (
  SELECT p.occurrence_id,p.title_redacted
  FROM content.hosted_placement p CROSS JOIN input i
  WHERE p.route=i.route AND p.catalogue_id=i.catalogue_id AND p.revision_id=i.revision_id
    AND (i.after_occurrence IS NULL OR p.occurrence_id>i.after_occurrence)
    AND EXISTS (
      SELECT 1 FROM content.hosted_structure_revision r
      WHERE r.route=i.route AND r.catalogue_id=i.catalogue_id
        AND r.revision_id=i.revision_id AND r.kind='structure'
    )
  ORDER BY p.occurrence_id LIMIT 100
), changed AS (
  UPDATE content.hosted_placement p SET title=NULL,title_redacted=true
  FROM page x CROSS JOIN input i
  WHERE p.route=i.route AND p.catalogue_id=i.catalogue_id
    AND p.revision_id=i.revision_id AND p.occurrence_id=x.occurrence_id
    AND NOT x.title_redacted
  RETURNING p.occurrence_id
)
SELECT x.occurrence_id,c.occurrence_id IS NOT NULL AS changed
FROM page x LEFT JOIN changed c USING (occurrence_id)
ORDER BY x.occurrence_id;
