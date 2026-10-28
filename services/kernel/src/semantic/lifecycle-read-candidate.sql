WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id, :candidate_id::uuid AS candidate_id
), candidate AS MATERIALIZED (
  SELECT c.origin, r.recorded_transaction_id
  FROM input
  JOIN semantic.candidate c ON c.route = input.route AND c.subject_id = input.subject_id
    AND c.candidate_id = input.candidate_id
  LEFT JOIN semantic.revision r
    ON r.route = input.route AND r.subject_id = c.subject_id AND r.revision = c.revision
), assertion AS MATERIALIZED (
  -- Exact fact_compact_candidate probe. Retraction/expansion never replaces assertion attribution.
  -- Two assertions suffice to detect ambiguous identity evidence without reading payload or history.
  SELECT f.recorded_transaction_id
  FROM input
  JOIN semantic.fact f ON f.route = input.route AND f.subject_id = input.subject_id
    AND f.statement_id = input.candidate_id
  WHERE f.statement_id IS NOT NULL
    AND f.kind = 'statement' AND f.operation = 'assert'
    AND NOT EXISTS (SELECT 1 FROM candidate WHERE origin = 'proposal')
  ORDER BY f.log_seq ASC LIMIT 2
), identity AS (
  SELECT recorded_transaction_id FROM candidate WHERE origin = 'proposal'
  UNION ALL
  SELECT CASE WHEN count(*) = 1 THEN (array_agg(recorded_transaction_id))[1] END
  FROM assertion
  HAVING count(*) > 0 OR EXISTS (SELECT 1 FROM candidate WHERE origin = 'compact')
)
SELECT b.principal_id::text AS account_id
FROM identity i
LEFT JOIN editorial.write_basis b
  ON b.partition_no = :partition_no::integer AND b.transaction_id = i.recorded_transaction_id
  AND b.principal_kind = 'account' AND b.principal_id = :account_id::uuid
LIMIT 1;
