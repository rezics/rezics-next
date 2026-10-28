-- Each mutually exclusive branch seeks its strict tuple before its exact limit.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :collection_id::uuid AS collection_id,
         :after_subject::nullable(uuid) AS after_subject, :after_fact::nullable(uuid) AS after_fact,
         :limit::integer AS batch_limit
)
SELECT raw.subject_id::text AS "storedSubjectId", raw.member_id::text AS "factId"
FROM input i CROSS JOIN LATERAL (
  (SELECT m.subject_id, m.member_id FROM library.collection_member m
   WHERE i.after_subject IS NULL AND m.route = i.route AND m.collection_id = i.collection_id
   ORDER BY m.subject_id, m.member_id LIMIT i.batch_limit)
  UNION ALL
  (SELECT m.subject_id, m.member_id FROM library.collection_member m
   WHERE i.after_subject IS NOT NULL AND m.route = i.route AND m.collection_id = i.collection_id
     AND (m.subject_id, m.member_id) > (i.after_subject, i.after_fact)
   ORDER BY m.subject_id, m.member_id LIMIT i.batch_limit)
) AS raw
ORDER BY raw.subject_id, raw.member_id;
