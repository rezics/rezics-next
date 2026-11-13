-- unbound: exact route/catalogue/revision is propagated through the modifying CTE
-- Include already redacted candidates so a repeated range has the same frontier.
WITH page AS MATERIALIZED (
  SELECT p.occurrence_id,p.title_redacted
  FROM content.hosted_placement p
  WHERE p.route=:route::integer AND p.catalogue_id=:catalogue_id::uuid
    AND p.revision_id=:revision_id::uuid
    AND (:after_occurrence::uuid IS NULL OR p.occurrence_id>:after_occurrence::uuid)
    AND EXISTS (
      SELECT 1 FROM content.hosted_structure_revision r
      WHERE r.route=:route::integer AND r.catalogue_id=:catalogue_id::uuid
        AND r.revision_id=:revision_id::uuid AND r.kind='structure'
    )
  ORDER BY p.occurrence_id LIMIT 100
), changed AS (
  UPDATE content.hosted_placement p SET title=NULL,title_redacted=true
  FROM page x
  WHERE p.route=:route::integer AND p.catalogue_id=:catalogue_id::uuid
    AND p.revision_id=:revision_id::uuid AND p.occurrence_id=x.occurrence_id
    AND NOT x.title_redacted
  RETURNING p.occurrence_id
)
SELECT x.occurrence_id,c.occurrence_id IS NOT NULL AS changed
FROM page x LEFT JOIN changed c USING (occurrence_id)
ORDER BY x.occurrence_id;
