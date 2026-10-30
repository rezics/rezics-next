WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :source::text AS source, :external_id::text AS external_id,
         :metadata::jsonb AS metadata, :expected_revision::bigint AS expected_revision, :transaction_id::uuid AS transaction_id
),
existing AS MATERIALIZED (
  SELECT stored.record, stored.metadata_revision
  FROM semantic.source_record AS stored CROSS JOIN input
  WHERE stored.route=input.route AND stored.source=input.source AND stored.external_id=input.external_id
),
decision AS MATERIALIZED (
  SELECT existing.record AS current_record, existing.metadata_revision AS current_revision,
         input.metadata, input.expected_revision, input.transaction_id,
         CASE
           WHEN input.expected_revision > 0 AND
                (existing.metadata_revision IS NULL OR existing.metadata_revision <> input.expected_revision)
             THEN true
           WHEN input.expected_revision = 0 AND existing.record IS NOT NULL AND EXISTS (
             SELECT 1
             FROM jsonb_each(jsonb_strip_nulls(jsonb_build_object(
               'name', existing.record->'name',
               'url', existing.record->'url',
               'licence.id', existing.record->'licence'->'id',
               'licence.url', existing.record->'licence'->'url',
               'attribution', existing.record->'attribution'
             ))) AS old_leaf(key, value)
             JOIN jsonb_each(jsonb_strip_nulls(jsonb_build_object(
               'name', input.metadata->'name',
               'url', input.metadata->'url',
               'licence.id', input.metadata->'licence'->'id',
               'licence.url', input.metadata->'licence'->'url',
               'attribution', input.metadata->'attribution'
             ))) AS new_leaf(key, value) USING (key)
             WHERE old_leaf.value IS DISTINCT FROM new_leaf.value
           ) THEN true
           ELSE false
         END AS conflict,
         CASE
           WHEN input.expected_revision > 0 THEN input.metadata
           WHEN existing.record IS NULL THEN input.metadata
           ELSE
             CASE WHEN existing.record ? 'licence' OR input.metadata ? 'licence'
               THEN jsonb_set(
                 existing.record || input.metadata,
                 '{licence}',
                 coalesce(existing.record->'licence', '{}'::jsonb) || coalesce(input.metadata->'licence', '{}'::jsonb),
                 true
               )
               ELSE existing.record || input.metadata
             END
         END AS next_record
  FROM input LEFT JOIN existing ON true
),
mutation AS (
  INSERT INTO semantic.source_record (route, source, external_id, record, metadata_revision, recorded_transaction_id)
  SELECT input.route, input.source, input.external_id, decision.next_record,
         coalesce(decision.current_revision, 0) + 1, decision.transaction_id
  FROM input CROSS JOIN decision
  WHERE NOT decision.conflict AND decision.next_record IS DISTINCT FROM decision.current_record
  ON CONFLICT (route, source, external_id) DO UPDATE SET
    record=EXCLUDED.record,
    metadata_revision=EXCLUDED.metadata_revision,
    recorded_transaction_id=EXCLUDED.recorded_transaction_id
  RETURNING record, metadata_revision
)
SELECT decision.conflict,
       coalesce(mutation.record, decision.current_record) AS record,
       coalesce(mutation.metadata_revision, decision.current_revision) AS metadata_revision,
       (mutation.metadata_revision IS NOT NULL) AS changed
FROM decision LEFT JOIN mutation ON true;
