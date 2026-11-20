-- A negative probe in the detail snapshot can skip an empty slot or preview.
-- Positive probes still go through the slot, projection and private audience readers.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id
)
SELECT scalar.property
FROM input CROSS JOIN unnest(:scalar_properties::text[], :slots::uuid[]) AS scalar(property, slot)
WHERE EXISTS (
  SELECT 1 FROM semantic.fact f
  WHERE f.route = input.route AND f.subject_id = input.subject_id AND f.slot_id = scalar.slot
)
UNION ALL
SELECT relation.property
FROM input CROSS JOIN unnest(:relation_properties::text[]) AS relation(property)
WHERE EXISTS (
  SELECT 1 FROM semantic.outbound_link l
  WHERE l.route = input.route AND l.subject_id = input.subject_id
    AND l.context_id IN ('00000000-0000-8000-8000-000000000000'::uuid, :context_id::uuid)
    AND l.property = relation.property AND l.filter_value = '00000000-0000-0000-0000-000000000000'::uuid
    AND l.present AND l.relation
) OR CASE WHEN :viewer_moderator::boolean THEN EXISTS (
  -- A moderator spans account ranges. One subject probe keeps the search bounded.
  SELECT 1 FROM semantic.statement_disclosure d
  WHERE d.route = input.route AND d.subject_id = input.subject_id AND NOT d.disclosed
) ELSE EXISTS (
  SELECT 1 FROM semantic.statement_disclosure d
  WHERE d.route = input.route AND d.subject_id = input.subject_id AND NOT d.disclosed
    AND d.account_id = :viewer_account::uuid AND d.property = relation.property
) END;
