SELECT f.statement_id::text AS candidate_id, f.body AS statement, f.body->>'rank' AS rank, f.relation,
       r.release, r.revision, f.log_seq AS view_order, f.operation, f.recorded_transaction_id::text AS tx
FROM (SELECT :route::integer AS route) AS input
JOIN semantic.fact f ON f.route = input.route AND f.subject_id = :subject_id::uuid AND f.slot_id = :slot_id::uuid
JOIN LATERAL (
  SELECT revision, release FROM semantic.revision
  WHERE route = input.route AND subject_id = f.subject_id AND recorded_transaction_id = f.recorded_transaction_id
  LIMIT 1
) r ON true
ORDER BY f.log_seq;
