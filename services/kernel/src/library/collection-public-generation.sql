WITH input AS NOT MATERIALIZED (SELECT $1::integer AS route, $2::uuid AS collection_id)
-- Current complete public generation, or the retained terminal generation when the head is gone.
SELECT h.generation::text AS generation, m.subject_id::text AS "subjectId"
FROM library.collection_source_output_head h
CROSS JOIN input
JOIN library.collection_source_output g
  ON (g.route, g.collection_id, g.generation) = (h.route, h.collection_id, h.generation)
LEFT JOIN library.collection_source_output_member m
  ON (m.route, m.collection_id, m.generation) = (h.route, h.collection_id, h.generation)
WHERE h.route = input.route AND h.collection_id = input.collection_id AND g.state = 'complete'
UNION ALL
SELECT r.generation::text, m.subject_id::text
FROM library.collection_retained_output r
CROSS JOIN input
LEFT JOIN library.collection_source_output_member m
  ON (m.route, m.collection_id, m.generation) = (r.route, r.collection_id, r.generation)
WHERE r.route = input.route AND r.collection_id = input.collection_id
  AND NOT EXISTS (
    SELECT 1 FROM library.collection_source_output_head h
    WHERE h.route = r.route AND h.collection_id = r.collection_id
  )
ORDER BY 1, 2;
