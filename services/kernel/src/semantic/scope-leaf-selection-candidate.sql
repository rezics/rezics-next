-- Exact candidate, current compact operation and recording provenance. Payloads are
-- guarded natively before they can cross the driver, including rejected witnesses.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id,
         :candidate_id::uuid AS candidate_id, :max_bytes::integer AS max_bytes
), expanded AS MATERIALIZED (
  SELECT slot_id, property, revision, release, statement,
         octet_length(statement::text) AS body_bytes
  FROM semantic.candidate CROSS JOIN input
  WHERE semantic.candidate.route = input.route AND semantic.candidate.subject_id = input.subject_id AND semantic.candidate.candidate_id = input.candidate_id
), compact AS MATERIALIZED (
  SELECT slot_id, property, log_seq, operation, body, release, recorded_transaction_id,
         octet_length(body::text) AS body_bytes
  FROM semantic.fact CROSS JOIN input
  WHERE semantic.fact.route = input.route AND semantic.fact.subject_id = input.subject_id AND statement_id = input.candidate_id
    AND kind = 'statement' AND statement_id IS NOT NULL
  ORDER BY log_seq DESC LIMIT 1
), chosen AS MATERIALIZED (
  SELECT e.slot_id, e.property, e.release, e.statement AS body, e.body_bytes,
         true AS expanded, NULL::uuid AS recorded_transaction_id, NULL::text AS operation
  FROM expanded e
  UNION ALL
  SELECT f.slot_id, f.property, f.release, f.body, f.body_bytes,
         false, f.recorded_transaction_id, f.operation
  FROM compact f WHERE NOT EXISTS (SELECT 1 FROM expanded)
)
SELECT c.slot_id::text AS slot_id,
       CASE WHEN c.body_bytes + octet_length(c.property) <= input.max_bytes THEN c.property END AS property,
       c.expanded, c.operation, c.release, c.body_bytes,
       CASE WHEN c.body_bytes + octet_length(c.property) <= input.max_bytes THEN c.body END AS body
FROM chosen c CROSS JOIN input;
