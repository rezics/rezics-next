WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id
), facts AS MATERIALIZED (
  SELECT f.*
  FROM semantic.fact AS f CROSS JOIN input
  WHERE f.route = input.route AND f.subject_id = input.subject_id
), fact_revisions AS MATERIALIZED (
  SELECT r.recorded_transaction_id, r.revision, r.release
  FROM (SELECT DISTINCT recorded_transaction_id FROM facts) AS transactions CROSS JOIN input
  JOIN semantic.revision AS r
    ON r.route = input.route AND r.subject_id = input.subject_id
   AND r.recorded_transaction_id = transactions.recorded_transaction_id
)
SELECT s.subject_id::text AS id,
       s.type,
       latest.revision,
       latest.release,
       f_revision.revision AS fact_revision,
       f_revision.release AS fact_release,
       f.slot_id::text AS slot_id,
       f.log_seq,
       f.operation,
       f.kind,
       f.language,
       f.property,
       f.statement_id::text AS statement_id,
       f.body
FROM semantic.subject AS s CROSS JOIN input
LEFT JOIN facts AS f ON true
LEFT JOIN LATERAL (
  SELECT revision, release
  FROM semantic.revision
  WHERE route = input.route AND subject_id = input.subject_id
  ORDER BY revision DESC
  LIMIT 1
) AS latest ON true
LEFT JOIN fact_revisions AS f_revision
  ON f_revision.recorded_transaction_id = f.recorded_transaction_id
WHERE s.route = input.route AND s.subject_id = input.subject_id
ORDER BY f.slot_id, f.log_seq;
