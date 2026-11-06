-- Current complete public generation, or the retained terminal generation when the head is gone.
SELECT h.generation::text AS generation, m.subject_id::text AS "subjectId"
FROM library.collection_source_output_head h
JOIN library.collection_source_output g
  ON (g.route, g.collection_id, g.generation) = (h.route, h.collection_id, h.generation)
LEFT JOIN library.collection_source_output_member m
  ON (m.route, m.collection_id, m.generation) = (h.route, h.collection_id, h.generation)
WHERE h.route = $1 AND h.collection_id = $2 AND g.state = 'complete'
UNION ALL
SELECT r.generation::text, m.subject_id::text
FROM library.collection_retained_output r
LEFT JOIN library.collection_source_output_member m
  ON (m.route, m.collection_id, m.generation) = (r.route, r.collection_id, r.generation)
WHERE r.route = $1 AND r.collection_id = $2
  AND NOT EXISTS (
    SELECT 1 FROM library.collection_source_output_head h
    WHERE h.route = r.route AND h.collection_id = r.collection_id
  )
ORDER BY 1, 2;
