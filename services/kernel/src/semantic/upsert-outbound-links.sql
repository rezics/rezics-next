-- Call once per Context, with Global first, so each statement sees the current base.
-- An active sparse row contributes local presence minus Global presence; a tombstone contributes zero.
WITH input AS NOT MATERIALIZED (SELECT :route::integer AS route), changes AS MATERIALIZED (
  SELECT change.*, COALESCE(change.context_id, '00000000-0000-8000-8000-000000000000'::uuid) AS ctx, COALESCE(change.suppressed, false) AS suppression, :transaction_id::uuid AS transaction_id
  FROM jsonb_to_recordset(:changes::jsonb) AS change(
    erasure_roles jsonb, context_id uuid, suppressed boolean, subject_id uuid, property text, filter_value uuid, order_key text, target_subject_id uuid,
    statement_id uuid, slot_id uuid, relation boolean, source_type text, source_order_key text, outbound_order text,
    source_revision integer, source_security_revision bigint, target_revision integer, target_type text,
    external text, value text, present boolean
  )
), checked AS MATERIALIZED (
  SELECT c.*, old.ctid AS old_tid, old.order_key AS old_order_key, old.target_subject_id AS old_target_subject_id,
         old.present AS was_present, old.suppressed AS was_suppressed, old.source_revision AS old_source_revision,
         old.source_security_revision AS old_source_security_revision, old.target_revision AS old_target_revision
  FROM changes c CROSS JOIN input
  LEFT JOIN LATERAL (
    SELECT old.*, old.ctid FROM semantic.outbound_link old
    WHERE old.route = input.route AND old.subject_id = c.subject_id AND old.context_id = c.ctx AND old.property = c.property
      AND old.filter_value = c.filter_value AND old.statement_id = c.statement_id
    ORDER BY old.source_revision DESC, old.source_security_revision DESC, old.target_revision DESC
    LIMIT 1
  ) old ON true
  WHERE old.source_revision IS NULL
     OR c.source_revision > old.source_revision
     OR (c.source_revision = old.source_revision AND c.source_security_revision > old.source_security_revision)
     OR (c.source_revision = old.source_revision AND c.source_security_revision = old.source_security_revision
       AND c.target_revision >= old.target_revision)
), inactive AS (
  -- The stable-identity probe already found these exact tuples in this statement's snapshot.
  -- A tuple-id array keeps deactivation independent of the holder's display-key history.
  UPDATE semantic.outbound_link old SET present = false
  FROM input
  WHERE old.route = input.route AND old.ctid = ANY(ARRAY(
    SELECT c.old_tid FROM checked c
    WHERE c.was_present
      AND (c.old_order_key, c.old_target_subject_id) IS DISTINCT FROM (c.order_key, c.target_subject_id)
  ))
  RETURNING old.subject_id
), written AS (
  INSERT INTO semantic.outbound_link (
    route, subject_id, context_id, property, filter_value, order_key, target_subject_id, statement_id, slot_id,
    relation, source_type, source_order_key, outbound_order, source_revision, source_security_revision,
    target_revision, target_type, external, value,
    present, suppressed, recorded_transaction_id, erasure_roles
  )
  SELECT input.route, subject_id, ctx, property, filter_value, order_key, target_subject_id, statement_id, slot_id,
    relation, source_type, source_order_key, outbound_order, source_revision, source_security_revision,
    target_revision, target_type, external, value,
    present, suppression, transaction_id, erasure_roles FROM checked CROSS JOIN input
  ON CONFLICT (route, subject_id, context_id, property, filter_value, order_key, target_subject_id, statement_id)
  DO UPDATE SET slot_id = EXCLUDED.slot_id, relation = EXCLUDED.relation, source_type = EXCLUDED.source_type,
    source_order_key = EXCLUDED.source_order_key, outbound_order = EXCLUDED.outbound_order,
    source_revision = EXCLUDED.source_revision,
    source_security_revision = EXCLUDED.source_security_revision, target_revision = EXCLUDED.target_revision,
    target_type = EXCLUDED.target_type, external = EXCLUDED.external, value = EXCLUDED.value,
    present = EXCLUDED.present, suppressed = EXCLUDED.suppressed, recorded_transaction_id = EXCLUDED.recorded_transaction_id, erasure_roles = EXCLUDED.erasure_roles
  RETURNING subject_id
), contributions AS (
  SELECT c.*, COALESCE(base.present, false)::integer AS base_present,
         COALESCE(c.was_present, false) AS prior_present, COALESCE(c.was_suppressed, false) AS prior_suppressed
  FROM checked c CROSS JOIN input
  LEFT JOIN LATERAL (
    SELECT base.present FROM semantic.outbound_link base
    WHERE c.ctx <> '00000000-0000-8000-8000-000000000000'
      AND base.route = input.route AND base.subject_id = c.subject_id
      AND base.context_id = '00000000-0000-8000-8000-000000000000' AND base.property = c.property
      AND base.filter_value = c.filter_value AND base.statement_id = c.statement_id
      AND base.present AND base.target_subject_id = c.target_subject_id
    LIMIT 1
  ) base ON true
), deltas AS (
  SELECT subject_id, ctx AS context_id, property, filter_value,
    sum(CASE WHEN ctx = '00000000-0000-8000-8000-000000000000' THEN present::integer - COALESCE(was_present, false)::integer
      ELSE CASE WHEN present THEN (NOT suppression)::integer - base_present ELSE 0 END
        - CASE WHEN prior_present THEN (NOT prior_suppressed)::integer - base_present ELSE 0 END END) AS delta
  FROM contributions WHERE relation GROUP BY subject_id, ctx, property, filter_value
  UNION ALL
  SELECT c.subject_id, local.context_id, c.property, c.filter_value,
    -sum(c.present::integer - COALESCE(c.was_present, false)::integer) AS delta
  FROM checked c CROSS JOIN input
  JOIN LATERAL (
    SELECT local.context_id FROM semantic.outbound_link local
    WHERE local.route = input.route AND local.subject_id = c.subject_id
      AND local.context_id <> '00000000-0000-8000-8000-000000000000' AND local.property = c.property
      AND local.filter_value = c.filter_value AND local.statement_id = c.statement_id AND local.present
      AND local.target_subject_id = c.target_subject_id
    OFFSET 0
  ) local ON true
  WHERE c.ctx = '00000000-0000-8000-8000-000000000000' AND c.relation
  GROUP BY c.subject_id, local.context_id, c.property, c.filter_value
), totals AS (
  SELECT subject_id, context_id, property, filter_value, sum(delta) AS delta
  FROM deltas GROUP BY subject_id, context_id, property, filter_value
)
 , local_counts AS (
  INSERT INTO semantic.outbound_link_context_count(route, subject_id, context_id, property, filter_value, value)
  SELECT input.route, d.subject_id, d.context_id, d.property, d.filter_value, COALESCE(c.value, 0) + d.delta
  FROM totals d CROSS JOIN input LEFT JOIN semantic.outbound_link_context_count c
    ON c.route = input.route AND c.subject_id = d.subject_id AND c.context_id = d.context_id
    AND c.property = d.property AND c.filter_value = d.filter_value
  WHERE d.delta <> 0 AND d.context_id <> '00000000-0000-8000-8000-000000000000'
  ON CONFLICT (route, subject_id, context_id, property, filter_value)
  DO UPDATE SET value = EXCLUDED.value
  RETURNING subject_id
)
INSERT INTO semantic.outbound_link_count(route, subject_id, property, filter_value, value)
SELECT input.route, d.subject_id, d.property, d.filter_value, COALESCE(c.value, 0) + d.delta
FROM totals d CROSS JOIN input LEFT JOIN semantic.outbound_link_count c
 ON c.route = input.route AND c.subject_id = d.subject_id AND c.property = d.property AND c.filter_value = d.filter_value
WHERE d.delta <> 0 AND d.context_id = '00000000-0000-8000-8000-000000000000'
ON CONFLICT (route, subject_id, property, filter_value)
DO UPDATE SET value = EXCLUDED.value;
