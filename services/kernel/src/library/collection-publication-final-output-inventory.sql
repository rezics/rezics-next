-- Exact retained output keys only. More than two rows is a refusal, never cleanup authority.
SELECT generation::text,state,output_mode AS "outputMode"
FROM library.collection_source_output
WHERE route=:route AND collection_id=:collection_id
ORDER BY generation
LIMIT 3;
