-- Exact current B and selected A only. Historical storage is not admission or cleanup authority.
SELECT generation::text,state,output_mode AS "outputMode"
FROM library.collection_source_output
WHERE route=:route AND collection_id=:collection_id AND generation=ANY(:generations::uuid[])
ORDER BY generation
LIMIT 3;
