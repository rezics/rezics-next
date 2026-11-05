WITH RECURSIVE input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :collection_id::uuid AS collection_id,
         :after::uuid AS after, :limit::integer AS page_limit
), subjects AS (
  (SELECT member.subject_id, 1 AS n FROM library.collection_member AS member CROSS JOIN input
   WHERE member.route = input.route AND member.collection_id = input.collection_id AND member.deletion_id IS NULL AND member.subject_id > input.after
   ORDER BY member.subject_id LIMIT 1)
  UNION ALL
  SELECT next.subject_id, subjects.n + 1
  FROM subjects CROSS JOIN input
  CROSS JOIN LATERAL (
    SELECT subject_id FROM library.collection_member
    WHERE route = input.route AND collection_id = input.collection_id AND deletion_id IS NULL AND subject_id > subjects.subject_id
    ORDER BY subject_id LIMIT 1
  ) AS next
  WHERE subjects.n < input.page_limit
)
SELECT subject_id AS "subjectId" FROM subjects ORDER BY subject_id;
