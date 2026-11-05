UPDATE semantic.identity_scope_summary SET state='ready',scan_complete=true,frontier='{"driver":"done"}'::jsonb
WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3 AND revision=1 AND active=0 AND state='capturing';
