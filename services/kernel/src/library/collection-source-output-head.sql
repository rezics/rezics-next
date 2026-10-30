-- Only the selected COMPLETE generation at the current native source fence is output.
SELECT h.generation::text AS generation
FROM library.collection_source_output_head h
JOIN library.collection_source_output g
  ON (g.route,g.collection_id,g.generation)=(h.route,h.collection_id,h.generation)
WHERE h.route=$1 AND h.collection_id=$2 AND h.source_generation=$3
  AND g.state='complete';
