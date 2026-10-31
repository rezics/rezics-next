WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no,
         :route::integer AS route,
         :subject_id::uuid AS subject_id,
         :properties::text[] AS properties,
         :after_property::text AS after_property,
         :after_slot::uuid AS after_slot,
         :after_candidate::uuid AS after_candidate
),
raw AS MATERIALIZED (
  SELECT selected.* FROM semantic.search_selected selected CROSS JOIN input
  WHERE selected.route = input.route AND selected.subject_id = input.subject_id
    AND selected.route >= input.partition_no * 16 AND selected.route < (input.partition_no + 1) * 16
    AND selected.property = ANY(input.properties) AND selected.active
    AND (input.after_property = '' OR
      (selected.property, selected.slot_id, selected.candidate_id) >
      (input.after_property COLLATE "C", input.after_slot, input.after_candidate))
  ORDER BY selected.property COLLATE "C", selected.slot_id, selected.candidate_id
  LIMIT :input_limit::integer
)
SELECT raw.route, raw.subject_id::text, raw.slot_id::text, raw.candidate_id::text, raw.property,
       raw.rank, raw.ordinal, raw.revision, raw.body, raw.release, raw.source, raw.compact,
       disclosure.account_id::text AS consent_account,
       (hidden.candidate_id IS NULL AND lifecycle.candidate_id IS NULL
         AND retracted.revision IS NULL AND (disclosure.candidate_id IS NULL OR disclosure.disclosed)
         AND (raw.compact OR accepted.verdict = 'accept'
              OR (candidate.origin = 'compact' AND accepted.verdict IS NULL))) AS eligible
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
  SELECT revision FROM semantic.retraction t
  WHERE t.route = raw.route AND t.subject_id = raw.subject_id AND t.candidate_id = raw.candidate_id
    AND t.route >= input.partition_no * 16 AND t.route < (input.partition_no + 1) * 16
  ORDER BY revision DESC LIMIT 1
) retracted ON true
LEFT JOIN LATERAL (
  SELECT candidate_id FROM semantic.record_lifecycle state
  WHERE state.route = raw.route AND state.subject_id = raw.subject_id
    AND state.candidate_id = raw.candidate_id AND state.state IN ('deleted', 'purging', 'purged')
    AND state.route >= input.partition_no * 16 AND state.route < (input.partition_no + 1) * 16
  LIMIT 1
) lifecycle ON true
ORDER BY raw.property COLLATE "C", raw.slot_id, raw.candidate_id;
