UPDATE semantic.subject_page_fanout SET version=version+1,source_key=:source_key::text[],
state=CASE WHEN :complete::boolean THEN 'done' ELSE 'pending' END,worker=NULL,lease_until=NULL,available_at=now()
WHERE route=:route::integer AND owner_kind=:owner_kind::text AND owner_key=:owner_key::text AND change_id=:change_id::text AND version=:version::bigint
RETURNING effective_at::text,evidence;
