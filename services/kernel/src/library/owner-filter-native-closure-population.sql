SELECT r.stored_subject_id::text AS original, r.canonical_subject_id::text AS terminal
FROM library.canonical_source_state s
JOIN library.canonical_source_reference r
  ON r.route=s.route AND r.collection_id=s.collection_id AND r.generation=s.ready_generation
WHERE s.route=:route AND s.collection_id=:collection_id
ORDER BY r.canonical_subject_id,r.stored_subject_id,r.driver,r.fact_id
LIMIT :limit;
