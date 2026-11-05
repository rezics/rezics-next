WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no
),
requested AS MATERIALIZED (
  SELECT ids.route, ids.subject_id
  FROM unnest(:routes::integer[], :subject_ids::uuid[]) AS ids(route, subject_id)
  CROSS JOIN input
  WHERE ids.route / 16 = input.partition_no
)
SELECT 'compact'::text AS entry_kind,
       selected.route,
       selected.subject_id::text AS id,
       selected.slot_id::text AS slot_id,
       selected.ordinal AS log_seq,
       'assert'::text AS operation,
       'statement'::text AS kind,
       NULL::text AS language,
       selected.property,
       selected.candidate_id::text AS candidate_id,
       selected.body,
       selected.release,
       selected.rank
FROM requested
CROSS JOIN LATERAL (
  SELECT s.route, s.subject_id, s.slot_id, s.candidate_id, s.property, s.ordinal, s.body, s.release, s.rank
  FROM semantic.search_selected s
  CROSS JOIN input
  WHERE s.route = requested.route AND s.subject_id = requested.subject_id
    AND s.route >= input.partition_no * 16 AND s.route < (input.partition_no + 1) * 16
    AND s.active AND s.relation IS FALSE
  ORDER BY s.property COLLATE "C", s.slot_id, s.candidate_id
  LIMIT :subject_limit::integer
) selected;
