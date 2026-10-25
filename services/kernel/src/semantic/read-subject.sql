SELECT s.subject_id::text AS id,
       f.slot_id::text AS slot_id,
       f.log_seq,
       f.operation,
       f.kind,
       f.language,
       f.property,
       f.statement_id::text AS statement_id,
       f.body
FROM semantic.subject AS s
LEFT JOIN semantic.fact AS f ON f.route = s.route AND f.subject_id = s.subject_id
WHERE s.route = :route::integer AND s.subject_id = :subject_id::uuid
ORDER BY f.slot_id, f.log_seq;
