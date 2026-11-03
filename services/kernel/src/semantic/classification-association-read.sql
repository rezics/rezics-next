WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id, :candidate_id::uuid AS candidate_id
), persisted AS (
  SELECT c.candidate_id, c.slot_id, c.property, c.statement, c.release, c.revision, c.relation
  FROM input
  JOIN semantic.candidate c
    ON c.route = input.route AND c.subject_id = input.subject_id AND c.candidate_id = input.candidate_id
), compact AS (
  SELECT f.statement_id AS candidate_id, f.slot_id, f.property, f.body AS statement,
         r.release, r.revision, f.relation
  FROM input
  JOIN semantic.fact f
    ON f.route = input.route AND f.subject_id = input.subject_id AND f.statement_id = input.candidate_id
  JOIN semantic.revision r
    ON r.route = f.route AND r.subject_id = f.subject_id
   AND r.recorded_transaction_id = f.recorded_transaction_id
  WHERE f.kind = 'statement' AND f.operation = 'assert'
    AND NOT EXISTS (
      SELECT 1 FROM semantic.candidate c
      WHERE c.route = f.route AND c.subject_id = f.subject_id AND c.candidate_id = f.statement_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM semantic.fact newer
      WHERE newer.route = f.route AND newer.subject_id = f.subject_id
        AND newer.slot_id = f.slot_id AND newer.statement_id = f.statement_id
        AND newer.log_seq > f.log_seq
    )
)
SELECT candidate_id::text AS "candidateId", slot_id::text AS "slotId", property,
       statement, release, revision, relation
FROM (
  SELECT * FROM persisted
  UNION ALL
  SELECT * FROM compact
) AS candidate
LIMIT 1;
