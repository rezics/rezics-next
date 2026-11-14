-- Bound raw keys before classifying their namespace; public snapshots still advance the frontier.
WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :catalogue_id::uuid AS catalogue_id,
         :after_namespace::uuid AS after_namespace, :after_occurrence::uuid AS after_occurrence,
         :after_language::text AS after_language
), page AS MATERIALIZED (
  SELECT s.namespace_id,s.occurrence_id,s.language,s.title_redacted
  FROM input i CROSS JOIN LATERAL (
    (SELECT namespace_id,occurrence_id,language,title_redacted
     FROM content.hosted_chapter_language_snapshot
     WHERE route=i.route AND catalogue_id=i.catalogue_id AND i.after_namespace IS NULL
     ORDER BY namespace_id,occurrence_id,language LIMIT 100)
    UNION ALL
    (SELECT namespace_id,occurrence_id,language,title_redacted
     FROM content.hosted_chapter_language_snapshot
     WHERE route=i.route AND catalogue_id=i.catalogue_id AND i.after_namespace IS NOT NULL
       AND (namespace_id,occurrence_id,language)>(i.after_namespace,i.after_occurrence,i.after_language COLLATE "C")
     ORDER BY namespace_id,occurrence_id,language LIMIT 100)
  ) s
), eligible AS MATERIALIZED (
  SELECT x.* FROM page x CROSS JOIN input i
  CROSS JOIN LATERAL (
    SELECT state FROM content.hosted_chapter_language_namespace
    WHERE route=i.route AND catalogue_id=i.catalogue_id AND namespace_id=x.namespace_id OFFSET 0
  ) n
  WHERE n.state IN ('open','sealed')
), changed AS (
  UPDATE content.hosted_chapter_language_snapshot s SET title=NULL,title_redacted=true
  FROM eligible x CROSS JOIN input i
  WHERE s.route=i.route AND s.catalogue_id=i.catalogue_id
    AND (s.namespace_id,s.occurrence_id,s.language)=(x.namespace_id,x.occurrence_id,x.language)
    AND NOT x.title_redacted
  RETURNING s.namespace_id,s.occurrence_id,s.language
)
SELECT p.namespace_id,p.occurrence_id,p.language,c.namespace_id IS NOT NULL AS changed
FROM page p LEFT JOIN changed c USING (namespace_id,occurrence_id,language)
ORDER BY p.namespace_id,p.occurrence_id,p.language;
