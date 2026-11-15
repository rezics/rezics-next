SELECT 1
FROM library.collection c
WHERE c.route=$1 AND c.collection_id=$2
 AND c.collection_id::text || ':' || extract(epoch FROM c.created_at)::text=$3
 AND c.builtin_kind IN ('everything','state') AND c.source_generation>$4
 AND NOT EXISTS (
   SELECT 1 FROM library.collection_retained_output f
   WHERE f.route=c.route AND f.collection_id=c.collection_id AND f.generation=$5
 )
FOR SHARE OF c;
