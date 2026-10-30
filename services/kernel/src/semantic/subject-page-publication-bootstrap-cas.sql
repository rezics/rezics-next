UPDATE semantic.subject_page_bootstrap SET version=version+1,source_key=:source_key::jsonb,
state=CASE WHEN :complete::boolean THEN 'done' ELSE 'pending' END,worker=NULL,lease_until=NULL,available_at=now()
WHERE partition_no=:partition::integer AND version=:version::bigint RETURNING version::text;
