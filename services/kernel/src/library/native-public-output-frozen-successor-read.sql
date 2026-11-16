SELECT 1
FROM library.native_public_output_binding b
JOIN library.collection c ON (c.route,c.collection_id)=(b.route,b.collection_id)
JOIN library.collection_source_output g ON (g.route,g.collection_id,g.generation)=(b.route,b.collection_id,b.output_generation)
JOIN LATERAL library.frozen_public_output_successor(b.route,b.collection_id,b.output_generation) proof ON true
WHERE b.partition_no=$1 AND b.capture_id=$2
  AND c.curator_account_id IS NULL AND g.account_id IS NULL;
