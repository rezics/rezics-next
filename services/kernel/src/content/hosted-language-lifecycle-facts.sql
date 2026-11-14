WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :catalogue_id::uuid AS catalogue_id,
         :after_occurrence::uuid AS after_occurrence, :after_language::text AS after_language,
         :after_version::bigint AS after_version
), page AS MATERIALIZED (
  SELECT b.occurrence_id,b.language,b.version,b.title,b.title_redacted
  FROM input i CROSS JOIN LATERAL (
    (SELECT occurrence_id,language,version,title,title_redacted
     FROM content.hosted_chapter_language_binding
     WHERE route=i.route AND catalogue_id=i.catalogue_id AND i.after_occurrence IS NULL
     ORDER BY occurrence_id,language,version LIMIT 100)
    UNION ALL
    (SELECT occurrence_id,language,version,title,title_redacted
     FROM content.hosted_chapter_language_binding
     WHERE route=i.route AND catalogue_id=i.catalogue_id AND i.after_occurrence IS NOT NULL
       AND (occurrence_id,language,version)>(i.after_occurrence,i.after_language COLLATE "C",i.after_version)
     ORDER BY occurrence_id,language,version LIMIT 100)
  ) b
), changed AS (
  UPDATE content.hosted_chapter_language_binding b SET title=NULL,title_redacted=true
  FROM page x CROSS JOIN input i
  WHERE b.route=i.route AND b.catalogue_id=i.catalogue_id
    AND (b.occurrence_id,b.language,b.version)=(x.occurrence_id,x.language,x.version)
    AND x.title IS NOT NULL AND NOT x.title_redacted
  RETURNING b.occurrence_id,b.language,b.version
)
SELECT p.occurrence_id,p.language,p.version::text,c.version IS NOT NULL AS changed
FROM page p LEFT JOIN changed c USING (occurrence_id,language,version)
ORDER BY p.occurrence_id,p.language,p.version;
