-- Merge the ordered layers, prefer Context at an equal key, then skip suppressions.
-- The outer limit stops the index ranges without materializing their full contents.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS r_route, :subject_id::uuid AS r_subject_id, :context_id::uuid AS r_context_id, :after_property::text AS r_after_property, :after_source::uuid AS r_after_source, :after_statement::uuid AS r_after_statement
)
SELECT property, subject, statement, type FROM (
  SELECT DISTINCT ON (property, sort_subject, sort_statement) * FROM (
(SELECT property, source_subject_id::text AS subject, statement_id::text AS statement, source_type AS type, source_subject_id AS sort_subject, statement_id AS sort_statement,
        false AS suppressed, 0 AS layer
  FROM semantic.inbound_link CROSS JOIN input
  WHERE route = input.r_route AND subject_id = input.r_subject_id AND present
    AND context_id = '00000000-0000-8000-8000-000000000000'::uuid
    AND filter_value = '00000000-0000-0000-0000-000000000000'
    AND (property, source_subject_id, statement_id) > (input.r_after_property, input.r_after_source, input.r_after_statement)
  ORDER BY property, source_subject_id, statement_id, layer DESC)
UNION ALL
(SELECT property, source_subject_id::text AS subject, statement_id::text AS statement, source_type AS type, source_subject_id AS sort_subject, statement_id AS sort_statement,
        suppressed, 1 AS layer
  FROM semantic.inbound_link CROSS JOIN input
  WHERE route = input.r_route AND subject_id = input.r_subject_id AND present
    AND context_id = input.r_context_id AND input.r_context_id <> '00000000-0000-8000-8000-000000000000'
    AND filter_value = '00000000-0000-0000-0000-000000000000'
    AND (property, source_subject_id, statement_id) > (input.r_after_property, input.r_after_source, input.r_after_statement)
  ORDER BY property, source_subject_id, statement_id, layer DESC)
  ) layers
  ORDER BY property, sort_subject, sort_statement, layer DESC
) selected
WHERE NOT suppressed
ORDER BY property, sort_subject, sort_statement
LIMIT :page_limit::integer;
