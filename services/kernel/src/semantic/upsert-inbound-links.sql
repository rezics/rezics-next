WITH input AS NOT MATERIALIZED (SELECT :route::integer AS route), changes AS MATERIALIZED (
  SELECT change.*, :transaction_id::uuid AS transaction_id
  FROM jsonb_to_recordset(:changes::jsonb) AS change(
    subject_id uuid, property text, source_subject_id uuid, statement_id uuid,
    source_revision integer, source_security_revision bigint, present boolean,
    source_type text, order_key text, filter_value uuid
  )
), accepted AS MATERIALIZED (
  SELECT c.*, COALESCE(old.present, false) AS was_present
  FROM changes c CROSS JOIN input LEFT JOIN semantic.inbound_link old
    ON old.route = input.route AND old.subject_id = c.subject_id AND old.property = c.property
    AND old.source_subject_id = c.source_subject_id AND old.statement_id = c.statement_id
    AND old.filter_value = c.filter_value
  WHERE old.source_revision IS NULL OR old.source_revision < c.source_revision
     OR (old.source_revision = c.source_revision AND old.source_security_revision < c.source_security_revision)
), written AS (
  INSERT INTO semantic.inbound_link (
    route, subject_id, property, source_subject_id, statement_id, source_revision,
    source_security_revision, present, recorded_transaction_id, source_type, order_key, filter_value
  )
  SELECT input.route, subject_id, property, source_subject_id, statement_id, source_revision,
    source_security_revision, present, transaction_id, source_type, order_key, filter_value FROM accepted CROSS JOIN input
  ON CONFLICT (route, subject_id, property, source_subject_id, statement_id, filter_value)
  DO UPDATE SET source_revision = EXCLUDED.source_revision,
    source_security_revision = EXCLUDED.source_security_revision, present = EXCLUDED.present,
    recorded_transaction_id = EXCLUDED.recorded_transaction_id,
    source_type = EXCLUDED.source_type, order_key = EXCLUDED.order_key
  RETURNING subject_id
), deltas AS (
  SELECT subject_id, property, filter_value,
    sum(present::integer - was_present::integer) AS delta FROM accepted
  GROUP BY subject_id, property, filter_value
)
INSERT INTO semantic.inbound_link_count(route, subject_id, property, filter_value, value)
SELECT input.route, d.subject_id, d.property, d.filter_value, COALESCE(c.value, 0) + d.delta
FROM deltas d CROSS JOIN input LEFT JOIN semantic.inbound_link_count c
 ON c.route = input.route AND c.subject_id = d.subject_id AND c.property = d.property AND c.filter_value = d.filter_value
WHERE d.delta <> 0
ON CONFLICT (route, subject_id, property, filter_value)
DO UPDATE SET value = EXCLUDED.value;
