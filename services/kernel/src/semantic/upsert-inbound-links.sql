-- Call once per Context, with Global first, so each statement sees the current base.
-- An active sparse row contributes local presence minus Global presence; a tombstone contributes zero.
WITH input AS NOT MATERIALIZED (SELECT :route::integer AS route), changes AS MATERIALIZED (
  SELECT change.*, COALESCE(change.context_id, '00000000-0000-8000-8000-000000000000'::uuid) AS ctx, COALESCE(change.suppressed, false) AS suppression, :transaction_id::uuid AS transaction_id
  FROM jsonb_to_recordset(:changes::jsonb) AS change(
    context_id uuid, suppressed boolean, subject_id uuid, property text, source_subject_id uuid, statement_id uuid,
    source_revision integer, source_security_revision bigint, present boolean,
    source_type text, order_key text, filter_value uuid
  )
), accepted AS MATERIALIZED (
  SELECT c.*, COALESCE(old.present, false) AS was_present, COALESCE(old.suppressed, false) AS was_suppressed
  FROM changes c CROSS JOIN input LEFT JOIN LATERAL (
    SELECT * FROM semantic.inbound_link old
    WHERE old.route = input.route AND old.subject_id = c.subject_id AND old.context_id = c.ctx AND old.property = c.property
      AND old.source_subject_id = c.source_subject_id AND old.statement_id = c.statement_id
      AND old.filter_value = c.filter_value
    LIMIT 1
  ) old ON true
  WHERE old.source_revision IS NULL OR old.source_revision < c.source_revision
     OR (old.source_revision = c.source_revision AND old.source_security_revision < c.source_security_revision)
), written AS (
  INSERT INTO semantic.inbound_link (
    route, subject_id, context_id, property, source_subject_id, statement_id, source_revision,
    source_security_revision, present, suppressed, recorded_transaction_id, source_type, order_key, filter_value
  )
  SELECT input.route, subject_id, ctx, property, source_subject_id, statement_id, source_revision,
    source_security_revision, present, suppression, transaction_id, source_type, order_key, filter_value FROM accepted CROSS JOIN input
  ON CONFLICT (route, subject_id, context_id, property, source_subject_id, statement_id, filter_value)
  DO UPDATE SET source_revision = EXCLUDED.source_revision,
    source_security_revision = EXCLUDED.source_security_revision, present = EXCLUDED.present, suppressed = EXCLUDED.suppressed,
    recorded_transaction_id = EXCLUDED.recorded_transaction_id,
    source_type = EXCLUDED.source_type, order_key = EXCLUDED.order_key
  RETURNING subject_id
), contributions AS (
  SELECT c.*, COALESCE(base.present, false)::integer AS base_present,
         COALESCE(c.was_present, false) AS prior_present, COALESCE(c.was_suppressed, false) AS prior_suppressed
  FROM accepted c CROSS JOIN input
  LEFT JOIN LATERAL (
    SELECT base.present FROM semantic.inbound_link base
    WHERE c.ctx <> '00000000-0000-8000-8000-000000000000'
      AND base.route = input.route AND base.subject_id = c.subject_id
      AND base.context_id = '00000000-0000-8000-8000-000000000000' AND base.property = c.property
      AND base.filter_value = c.filter_value AND base.statement_id = c.statement_id
      AND base.source_subject_id = c.source_subject_id
    LIMIT 1
  ) base ON true
), deltas AS (
  SELECT subject_id, ctx AS context_id, property, filter_value,
    sum(CASE WHEN ctx = '00000000-0000-8000-8000-000000000000' THEN present::integer - COALESCE(was_present, false)::integer
      ELSE CASE WHEN present THEN (NOT suppression)::integer - base_present ELSE 0 END
        - CASE WHEN prior_present THEN (NOT prior_suppressed)::integer - base_present ELSE 0 END END) AS delta
  FROM contributions  GROUP BY subject_id, ctx, property, filter_value
  UNION ALL
  SELECT c.subject_id, local.context_id, c.property, c.filter_value,
    -sum(c.present::integer - COALESCE(c.was_present, false)::integer) AS delta
  FROM accepted c CROSS JOIN input
  JOIN LATERAL (
    SELECT local.context_id FROM semantic.inbound_link local
    WHERE local.route = input.route AND local.subject_id = c.subject_id
      AND local.context_id <> '00000000-0000-8000-8000-000000000000' AND local.property = c.property
      AND local.filter_value = c.filter_value AND local.statement_id = c.statement_id AND local.present
      AND local.source_subject_id = c.source_subject_id
    OFFSET 0
  ) local ON true
  WHERE c.ctx = '00000000-0000-8000-8000-000000000000'
  GROUP BY c.subject_id, local.context_id, c.property, c.filter_value
), totals AS (
  SELECT subject_id, context_id, property, filter_value, sum(delta) AS delta
  FROM deltas GROUP BY subject_id, context_id, property, filter_value
)
 , local_counts AS (
  INSERT INTO semantic.inbound_link_context_count(route, subject_id, context_id, property, filter_value, value)
  SELECT input.route, d.subject_id, d.context_id, d.property, d.filter_value, COALESCE(c.value, 0) + d.delta
  FROM totals d CROSS JOIN input LEFT JOIN semantic.inbound_link_context_count c
    ON c.route = input.route AND c.subject_id = d.subject_id AND c.context_id = d.context_id
    AND c.property = d.property AND c.filter_value = d.filter_value
  WHERE d.delta <> 0 AND d.context_id <> '00000000-0000-8000-8000-000000000000'
  ON CONFLICT (route, subject_id, context_id, property, filter_value)
  DO UPDATE SET value = EXCLUDED.value
  RETURNING subject_id
)
INSERT INTO semantic.inbound_link_count(route, subject_id, property, filter_value, value)
SELECT input.route, d.subject_id, d.property, d.filter_value, COALESCE(c.value, 0) + d.delta
FROM totals d CROSS JOIN input
LEFT JOIN LATERAL (
  SELECT c.value FROM semantic.inbound_link_count c
  WHERE c.route = input.route AND c.subject_id = d.subject_id
    AND c.property = d.property AND c.filter_value = d.filter_value
  LIMIT 1
) c ON true
WHERE d.delta <> 0 AND d.context_id = '00000000-0000-8000-8000-000000000000'
ON CONFLICT (route, subject_id, property, filter_value)
DO UPDATE SET value = EXCLUDED.value;
