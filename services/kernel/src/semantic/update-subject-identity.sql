WITH input AS NOT MATERIALIZED (
 SELECT :route::integer AS route, :subject_id::uuid AS subject_id, :transaction_id::uuid AS transaction_id, :release::text AS release, :type::text AS type, :revision::integer AS revision, :source::jsonb AS source
), labels AS MATERIALIZED (
 SELECT label.* FROM jsonb_to_recordset(:labels::jsonb) AS label(slot_id uuid, language text, body jsonb)
), changed AS (
 UPDATE semantic.subject s SET type = input.type, current_release = input.release,
 current_facts = current_facts + (SELECT count(*) FROM labels)
 FROM input WHERE s.route = input.route AND s.subject_id = input.subject_id
 RETURNING s.subject_id
), revision AS (
 INSERT INTO semantic.revision(route,subject_id,revision,kind,release,recorded_transaction_id,source)
 SELECT route, subject_id, revision, 'identity', release, transaction_id, source FROM input
)
INSERT INTO semantic.fact(route,subject_id,slot_id,log_seq,operation,kind,language,body,recorded_transaction_id)
SELECT input.route,input.subject_id,l.slot_id,COALESCE((
 SELECT max(f.log_seq) FROM semantic.fact f
 WHERE f.route = input.route AND f.subject_id = input.subject_id AND f.slot_id = l.slot_id
),0)+1,'assert','label',l.language,l.body,input.transaction_id
FROM input CROSS JOIN labels l;
