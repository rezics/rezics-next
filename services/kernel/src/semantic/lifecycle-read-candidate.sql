WITH candidate AS MATERIALIZED (
  SELECT c.origin, r.recorded_transaction_id
  FROM semantic.candidate c
  LEFT JOIN semantic.revision r
    ON r.route = :route::integer AND r.subject_id = c.subject_id AND r.revision = c.revision
  WHERE c.route = :route::integer AND c.subject_id = :subject_id::uuid
    AND c.candidate_id = :candidate_id::uuid
), assertion AS MATERIALIZED (
  -- Exact fact_compact_candidate probe. Retraction/expansion never replaces assertion attribution.
  -- Two assertions suffice to detect ambiguous identity evidence without reading payload or history.
  SELECT f.recorded_transaction_id
  FROM semantic.fact f
  WHERE f.route = :route::integer AND f.subject_id = :subject_id::uuid
    AND f.statement_id = :candidate_id::uuid AND f.statement_id IS NOT NULL
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
