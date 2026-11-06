WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no,
         :route::integer AS route,
         :subject_id::uuid AS subject_id,
         :property::text AS property,
         :candidate_id::uuid AS candidate_id
)
SELECT raw.*,
  (hidden.candidate_id IS NULL AND retracted.revision IS NULL
    AND (disclosure.candidate_id IS NULL OR disclosure.disclosed)
    AND (raw.compact OR accepted.verdict = 'accept' OR (candidate.origin = 'compact' AND accepted.verdict IS NULL))) AS eligible
FROM (
  SELECT selected.*
  FROM semantic.search_selected selected
  CROSS JOIN input
  WHERE selected.route = input.route AND selected.subject_id = input.subject_id
    AND selected.property = input.property COLLATE "C"
    AND selected.candidate_id = input.candidate_id
    AND selected.active
    AND selected.route >= input.partition_no * 16
    AND selected.route < (input.partition_no + 1) * 16
  ORDER BY selected.slot_id, selected.candidate_id
  LIMIT 2
) raw
CROSS JOIN input
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
) retracted ON true;
