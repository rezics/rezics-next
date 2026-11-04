WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no,
         :subject_limit::integer AS subject_limit
),
requested AS MATERIALIZED (
  SELECT ids.route, ids.subject_id
  FROM unnest(:routes::integer[], :subject_ids::uuid[]) AS ids(route, subject_id)
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
CROSS JOIN input
JOIN semantic.search_selection_state state
  ON state.route = requested.route AND state.subject_id = requested.subject_id
  AND state.ready
  AND state.route >= input.partition_no * 16
  AND state.route < (input.partition_no + 1) * 16
JOIN LATERAL (
  SELECT s.route, s.subject_id, s.slot_id, s.candidate_id, s.property, s.ordinal, s.body, s.release, s.rank
  FROM semantic.search_selected s
  CROSS JOIN input
  WHERE s.route = requested.route AND s.subject_id = requested.subject_id
    AND s.route >= input.partition_no * 16
    AND s.route < (input.partition_no + 1) * 16
    AND s.active
    AND NOT s.relation
  ORDER BY s.property, s.slot_id, s.candidate_id
  LIMIT input.subject_limit
) selected ON true
WHERE requested.route >= input.partition_no * 16
  AND requested.route < (input.partition_no + 1) * 16;
