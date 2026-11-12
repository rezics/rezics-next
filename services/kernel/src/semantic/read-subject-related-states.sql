-- Current visibility floor for one bounded summary-read batch in an exact home.
WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no
), requested AS NOT MATERIALIZED (
  SELECT route, subject_id
  FROM unnest(:routes::integer[], :subject_ids::uuid[]) AS wanted(route, subject_id)
)
SELECT requested.subject_id::text AS id, subject.visibility
FROM requested
CROSS JOIN input
LEFT JOIN LATERAL (
  SELECT subject.visibility
  FROM semantic.subject AS subject
  WHERE subject.route = requested.route
    AND subject.subject_id = requested.subject_id
    AND subject.route >= input.partition_no * 16
    AND subject.route < (input.partition_no + 1) * 16
  LIMIT 1
) AS subject ON true;
