WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id, :candidate_id::uuid AS candidate_id
), located AS (
  SELECT r.revision, c.origin, c.property, c.slot_id, c.relation
  FROM input i
  JOIN semantic.candidate c ON c.route=i.route AND c.subject_id=i.subject_id AND c.candidate_id=i.candidate_id
  JOIN semantic.revision r ON r.route=c.route AND r.subject_id=c.subject_id AND r.revision=c.revision
  WHERE c.origin='proposal'
  UNION ALL
  SELECT r.revision, 'compact'::text AS origin, f.property, f.slot_id, f.relation
  FROM input i
  JOIN semantic.fact f ON f.route=i.route AND f.subject_id=i.subject_id AND f.statement_id=i.candidate_id
    AND f.kind='statement' AND f.operation='assert'
    AND NOT EXISTS (
      SELECT 1 FROM semantic.fact other
      WHERE other.route=f.route AND other.subject_id=f.subject_id AND other.statement_id=f.statement_id
        AND other.kind='statement' AND other.operation='assert' AND other.log_seq<>f.log_seq
    )
  JOIN semantic.revision r ON r.route=f.route AND r.subject_id=f.subject_id
    AND r.recorded_transaction_id=f.recorded_transaction_id
  WHERE NOT EXISTS (
    SELECT 1 FROM semantic.candidate c WHERE c.route=i.route AND c.subject_id=i.subject_id
      AND c.candidate_id=i.candidate_id AND c.origin='proposal'
  )
  ORDER BY revision LIMIT 1
)
SELECT revision, origin, property, slot_id::text AS slot_id, relation FROM located;
