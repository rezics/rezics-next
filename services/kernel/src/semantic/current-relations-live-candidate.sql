WITH input AS MATERIALIZED (
  SELECT *
  FROM jsonb_to_recordset(:candidates::jsonb) AS candidate(
    route integer,
    subject_id uuid,
    candidate_id uuid,
    slot_id uuid
  )
)
SELECT input.subject_id::text AS subject_id, input.candidate_id::text AS candidate_id,
       COALESCE(candidate.property, slot_fact.property, identity_fact.property) AS property,
       COALESCE(candidate.slot_id, slot_fact.slot_id, identity_fact.slot_id)::text AS slot_id,
       COALESCE(candidate.relation, slot_fact.relation, identity_fact.relation) AS relation
FROM input
LEFT JOIN LATERAL (
  SELECT c.candidate_id, c.property, c.slot_id, c.relation
  FROM semantic.candidate AS c
  WHERE c.route = input.route AND c.subject_id = input.subject_id AND c.candidate_id = input.candidate_id
    AND (input.slot_id IS NULL OR c.slot_id = input.slot_id)
  LIMIT 1
) AS candidate ON true
LEFT JOIN LATERAL (
  SELECT head.statement_id, head.property, head.slot_id, head.relation
  FROM (
    SELECT f.statement_id, f.operation, f.property, f.slot_id, f.relation
    FROM semantic.fact AS f
    WHERE candidate.candidate_id IS NULL AND input.slot_id IS NOT NULL
      AND f.route = input.route AND f.subject_id = input.subject_id AND f.slot_id = input.slot_id
      AND f.statement_id = input.candidate_id AND f.statement_id IS NOT NULL AND f.kind = 'statement'
    ORDER BY f.log_seq DESC
    LIMIT 1
  ) AS head
  WHERE head.operation = 'assert'
) AS slot_fact ON true
LEFT JOIN LATERAL (
  -- Statement identities belong to one slot; a slot log is capped at 33 rows.
  SELECT head.statement_id, head.property, head.slot_id, head.relation
  FROM (
    SELECT f.statement_id, f.operation, f.property, f.slot_id, f.relation
    FROM semantic.fact AS f
    WHERE candidate.candidate_id IS NULL AND input.slot_id IS NULL
      AND f.route = input.route AND f.subject_id = input.subject_id
      AND f.statement_id = input.candidate_id AND f.statement_id IS NOT NULL AND f.kind = 'statement'
    ORDER BY f.log_seq DESC
    LIMIT 1
  ) AS head
  WHERE head.operation = 'assert'
) AS identity_fact ON true
WHERE COALESCE(candidate.candidate_id, slot_fact.statement_id, identity_fact.statement_id) IS NOT NULL;
