SELECT s.subject_id::text AS id, s.type, latest.revision, latest.release,
       r.revision AS fact_revision, r.release AS fact_release,
       f.slot_id::text AS slot_id, f.log_seq, f.operation, f.kind,
       f.language, f.property, f.statement_id::text AS statement_id, f.body
FROM semantic.subject AS s
LEFT JOIN LATERAL (
  SELECT revision, release FROM semantic.revision
  WHERE route = s.route AND subject_id = s.subject_id
  ORDER BY revision DESC LIMIT 1
) AS latest ON true
LEFT JOIN semantic.fact AS f ON f.route = s.route AND f.subject_id = s.subject_id AND f.kind <> 'statement'
LEFT JOIN LATERAL (
  SELECT revision, release FROM semantic.revision
  WHERE route = s.route AND subject_id = s.subject_id AND recorded_transaction_id = f.recorded_transaction_id
  LIMIT 1
) AS r ON true
WHERE s.route = :route::integer AND s.subject_id = :subject_id::uuid AND s.visibility = 'visible'
ORDER BY f.slot_id, f.log_seq;
