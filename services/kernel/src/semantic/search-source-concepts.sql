WITH input AS NOT MATERIALIZED (SELECT :partition_no::integer AS partition_no),
raw AS MATERIALIZED (
  SELECT selected.* FROM jsonb_to_recordset(:requests::jsonb) AS properties(route integer, subject_id uuid, property text, after_slot uuid, after_candidate uuid)
  CROSS JOIN LATERAL (
    SELECT s.* FROM semantic.search_selected s CROSS JOIN input
    WHERE s.route = properties.route AND s.subject_id = properties.subject_id
      AND s.route >= input.partition_no * 16 AND s.route < (input.partition_no + 1) * 16
      AND s.property = properties.property COLLATE "C" AND s.active
      AND (s.slot_id, s.candidate_id) > (properties.after_slot, properties.after_candidate)
    ORDER BY s.slot_id, s.candidate_id LIMIT :property_limit::integer
  ) selected
  LIMIT :input_limit::integer
)
SELECT raw.*,
  (hidden.candidate_id IS NULL AND retracted.revision IS NULL
    AND (disclosure.candidate_id IS NULL OR disclosure.disclosed)
    AND (raw.compact OR accepted.verdict = 'accept' OR (candidate.origin = 'compact' AND accepted.verdict IS NULL))) AS eligible
FROM raw CROSS JOIN input
LEFT JOIN semantic.candidate candidate ON candidate.route = raw.route AND candidate.subject_id = raw.subject_id
  AND candidate.slot_id = raw.slot_id AND candidate.candidate_id = raw.candidate_id
  AND candidate.route >= input.partition_no * 16 AND candidate.route < (input.partition_no + 1) * 16
LEFT JOIN semantic.hidden_candidate hidden ON hidden.route = raw.route AND hidden.subject_id = raw.subject_id
  AND hidden.candidate_id = raw.candidate_id
  AND hidden.route >= input.partition_no * 16 AND hidden.route < (input.partition_no + 1) * 16
LEFT JOIN semantic.statement_disclosure disclosure ON disclosure.route = raw.route
  AND disclosure.subject_id = raw.subject_id AND disclosure.candidate_id = raw.candidate_id
  AND disclosure.route >= input.partition_no * 16 AND disclosure.route < (input.partition_no + 1) * 16
LEFT JOIN semantic.acceptance_current accepted ON accepted.route = raw.route AND accepted.subject_id = raw.subject_id
  AND accepted.context_id = '00000000-0000-8000-8000-000000000000'::uuid AND accepted.candidate_id = raw.candidate_id
  AND accepted.route >= input.partition_no * 16 AND accepted.route < (input.partition_no + 1) * 16
LEFT JOIN LATERAL (
  SELECT revision FROM semantic.retraction t WHERE t.route = raw.route AND t.subject_id = raw.subject_id
    AND t.candidate_id = raw.candidate_id
    AND t.route >= input.partition_no * 16 AND t.route < (input.partition_no + 1) * 16
  ORDER BY revision DESC LIMIT 1
) retracted ON true
ORDER BY raw.property, raw.slot_id, raw.candidate_id;
