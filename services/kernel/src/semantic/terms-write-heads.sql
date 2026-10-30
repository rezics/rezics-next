INSERT INTO semantic.term_head(route,subject_id,kind,language,slot_id,first_seq,support_transaction_id,active)
SELECT :route::integer,:subject_id::uuid,head.kind,head.language,head.slot_id,1,:transaction_id::uuid,head.active
FROM jsonb_to_recordset(:heads::jsonb) AS head(kind text,language text,slot_id uuid,active boolean)
ON CONFLICT(route,subject_id,kind,language) DO UPDATE
SET slot_id=EXCLUDED.slot_id,first_seq=1,active=EXCLUDED.active;
