UPDATE semantic.subject_page_repair SET version=version+1,phase=:phase::text,source_key=:source_key::text[],
replay_position=:replay_position::bigint,state=CASE WHEN :complete::boolean THEN 'done' ELSE 'pending' END,
worker=NULL,lease_until=NULL,available_at=now() WHERE route=:route::integer AND subject_id=:subject_id::uuid AND version=:version::bigint
AND generation=:generation::bigint AND high_water=:high_water::bigint
RETURNING dirty;
