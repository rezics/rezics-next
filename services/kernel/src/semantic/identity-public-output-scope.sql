SELECT s.revision::text,s.active,s.state,s.scan_complete,s.registration::text,s.capture_id::text,s.capture,s.source
FROM semantic.identity_scope_summary s
WHERE s.partition_no=$1 AND s.source_key=$2 AND s.scope_id=$3
FOR UPDATE OF s;
