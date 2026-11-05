-- A single exact inherited row; sparse Context adjustment has its own raw-90 phase.
WITH input AS (
 SELECT $1::integer route,$2::uuid subject_id,$3::uuid context_id,$4::text property,
   $5::uuid source_subject_id,$6::uuid statement_id,$7::uuid filter_value,
   $8::integer source_revision,$9::bigint source_security_revision
), removed AS (
 DELETE FROM semantic.inbound_link l USING input i
 WHERE (l.route,l.subject_id,l.context_id,l.property,l.source_subject_id,l.statement_id,l.filter_value)=
   (i.route,i.subject_id,i.context_id,i.property,i.source_subject_id,i.statement_id,i.filter_value)
   AND (l.source_revision,l.source_security_revision)<=(i.source_revision,i.source_security_revision)
 RETURNING l.*
), delta AS (
 SELECT r.*,CASE WHEN r.context_id='00000000-0000-8000-8000-000000000000'::uuid
   THEN -r.present::integer ELSE
   -CASE WHEN r.present THEN (NOT r.suppressed)::integer-coalesce(b.present,false)::integer ELSE 0 END END value
 FROM removed r LEFT JOIN LATERAL (
   SELECT l.present FROM semantic.inbound_link l WHERE l.route=r.route AND l.subject_id=r.subject_id
     AND l.context_id='00000000-0000-8000-8000-000000000000'::uuid AND l.property=r.property
     AND l.filter_value=r.filter_value AND l.source_subject_id=r.source_subject_id AND l.statement_id=r.statement_id
   LIMIT 1
 ) b ON r.context_id<>'00000000-0000-8000-8000-000000000000'::uuid
), global_count AS (
 INSERT INTO semantic.inbound_link_count(route,subject_id,property,filter_value,value)
 SELECT d.route,d.subject_id,d.property,d.filter_value,coalesce(c.value,0)+d.value FROM delta d
 LEFT JOIN semantic.inbound_link_count c ON (c.route,c.subject_id,c.property,c.filter_value)=(d.route,d.subject_id,d.property,d.filter_value)
 WHERE d.context_id='00000000-0000-8000-8000-000000000000'::uuid AND d.value<>0
 ON CONFLICT(route,subject_id,property,filter_value) DO UPDATE
 SET value=EXCLUDED.value RETURNING subject_id
), local_count AS (
 INSERT INTO semantic.inbound_link_context_count(route,subject_id,context_id,property,filter_value,value)
 SELECT route,subject_id,context_id,property,filter_value,value FROM delta
 WHERE context_id<>'00000000-0000-8000-8000-000000000000'::uuid AND value<>0
 ON CONFLICT(route,subject_id,context_id,property,filter_value) DO UPDATE
 SET value=semantic.inbound_link_context_count.value+EXCLUDED.value RETURNING subject_id
)
SELECT coalesce(sum(value),0)::integer global_delta FROM delta
WHERE context_id='00000000-0000-8000-8000-000000000000'::uuid;
