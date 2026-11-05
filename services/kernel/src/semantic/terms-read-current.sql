SELECT f.slot_id::text,f.log_seq,f.operation,f.kind,f.language,f.property,
  f.statement_id::text,f.body,f.erasure_key::text,
  r.revision AS support_revision,r.source
FROM semantic.current_term_fact f
JOIN LATERAL (
  SELECT revision,source FROM semantic.revision r
  WHERE r.route=f.route AND r.subject_id=f.subject_id AND r.recorded_transaction_id=f.recorded_transaction_id
  LIMIT 1
) r ON true
WHERE f.route=:route::integer AND f.subject_id=:subject_id::uuid
ORDER BY f.kind,f.language,f.log_seq;
