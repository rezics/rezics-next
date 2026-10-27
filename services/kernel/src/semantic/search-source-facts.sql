WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no
),
requested AS MATERIALIZED (
  SELECT ids.route, ids.subject_id
  FROM unnest(:routes::integer[], :subject_ids::uuid[]) AS ids(route, subject_id)
), term_rows AS MATERIALIZED (
  SELECT requested.route, requested.subject_id, fact.slot_id, fact.log_seq, fact.operation,
         fact.kind, fact.language, fact.property, fact.statement_id, fact.body, fact.release
  FROM requested
  CROSS JOIN LATERAL (
    SELECT f.slot_id, f.log_seq, f.operation, f.kind, f.language, f.property,
           f.statement_id, f.body, f.release
    FROM semantic.fact f
    CROSS JOIN input
    WHERE f.route = requested.route AND f.subject_id = requested.subject_id AND f.kind <> 'statement'
      AND f.route >= input.partition_no * 16
      AND f.route < (input.partition_no + 1) * 16
    ORDER BY f.slot_id, f.log_seq
  ) fact
), statement_rows AS MATERIALIZED (
  SELECT requested.route, requested.subject_id, fact.slot_id, fact.log_seq, fact.operation,
         fact.kind, fact.language, fact.property, fact.statement_id, fact.body, fact.release
  FROM requested
  CROSS JOIN LATERAL (
    SELECT f.slot_id, f.log_seq, f.operation, f.kind, f.language, f.property,
           f.statement_id, f.body, f.release
    FROM semantic.fact f
    CROSS JOIN input
    WHERE f.route = requested.route AND f.subject_id = requested.subject_id AND f.kind = 'statement'
      AND NOT f.relation
      AND f.route >= input.partition_no * 16
      AND f.route < (input.partition_no + 1) * 16
    ORDER BY f.slot_id, f.log_seq
  ) fact
), slot_heads AS (
  SELECT DISTINCT ON (route, subject_id, slot_id)
         route, subject_id, slot_id, property, operation, log_seq
  FROM statement_rows
  ORDER BY route, subject_id, slot_id, log_seq DESC
), compact_latest AS (
  SELECT DISTINCT ON (f.route, f.subject_id, f.slot_id, f.statement_id)
         f.route, f.subject_id, f.slot_id, f.log_seq, f.property, f.statement_id, f.body, f.release, f.operation
  FROM statement_rows f
  JOIN slot_heads h
    ON h.route = f.route AND h.subject_id = f.subject_id AND h.slot_id = f.slot_id
  WHERE h.operation <> 'expand'
  ORDER BY f.route, f.subject_id, f.slot_id, f.statement_id, f.log_seq DESC
)
SELECT 'term'::text AS entry_kind, route, subject_id::text AS id, slot_id::text AS slot_id,
       log_seq, operation, kind, language, property, statement_id::text AS candidate_id, body, release
FROM term_rows
UNION ALL
SELECT 'compact'::text, route, subject_id::text, slot_id::text,
       log_seq, operation, 'statement'::text, NULL::text, property, statement_id::text, body, release
FROM compact_latest
WHERE operation = 'assert' AND body->>'rank' IN ('normal', 'preferred')
UNION ALL
SELECT 'expanded'::text, route, subject_id::text, slot_id::text,
       log_seq, operation, 'statement'::text, NULL::text, property, NULL::text, NULL::jsonb, NULL::text
FROM slot_heads
WHERE operation = 'expand';
