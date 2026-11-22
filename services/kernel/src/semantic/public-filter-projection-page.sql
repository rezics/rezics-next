WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no,
         :route::integer AS route,
         :subject_id::uuid AS subject_id,
         :properties::text[] AS properties,
         :after_property::text AS after_property,
         :after_slot::uuid AS after_slot,
         :after_candidate::uuid AS after_candidate,
         :input_limit::integer AS page_limit
),
raw AS MATERIALIZED (
  -- Walk the released properties in index order so a full page can stop early.
  SELECT page.* FROM input
  CROSS JOIN LATERAL (
    SELECT DISTINCT p.property COLLATE "C" AS property
    FROM unnest(input.properties) AS p(property)
    WHERE p.property COLLATE "C" >= input.after_property COLLATE "C"
    ORDER BY property
  ) keys
  CROSS JOIN LATERAL (
    -- The inclusive lower tuple starts at the cursor or the first UUID of the next property.
    -- The upper prefix closes the same route, Subject and property in search_selected_page.
    SELECT selected.* FROM semantic.search_selected selected
    WHERE selected.active
      AND input.route >= input.partition_no * 16 AND input.route < (input.partition_no + 1) * 16
      AND (selected.route, selected.subject_id, selected.property, selected.slot_id, selected.candidate_id) >=
        (input.route, input.subject_id, keys.property,
         CASE WHEN keys.property = input.after_property THEN input.after_slot ELSE '00000000-0000-0000-0000-000000000000'::uuid END,
         CASE WHEN keys.property = input.after_property THEN input.after_candidate ELSE '00000000-0000-0000-0000-000000000000'::uuid END)
      AND (selected.route, selected.subject_id, selected.property) <= (input.route, input.subject_id, keys.property)
      AND (selected.property, selected.slot_id, selected.candidate_id) <>
        (input.after_property COLLATE "C", input.after_slot, input.after_candidate)
    ORDER BY selected.route, selected.subject_id, selected.property COLLATE "C", selected.slot_id, selected.candidate_id
    LIMIT input.page_limit
  ) page
  ORDER BY keys.property, page.slot_id, page.candidate_id
  LIMIT (SELECT page_limit FROM input)
)
SELECT raw.route, raw.subject_id::text, raw.slot_id::text, raw.candidate_id::text, raw.property,
       raw.rank, raw.ordinal, raw.revision, raw.body, raw.release, raw.source, raw.compact,
       disclosure.account_id::text AS consent_account,
       (hidden.candidate_id IS NULL AND lifecycle.candidate_id IS NULL
         AND retracted.revision IS NULL AND (disclosure.candidate_id IS NULL OR disclosure.disclosed)
         AND (raw.compact OR accepted.verdict = 'accept'
              OR (candidate.origin = 'compact' AND accepted.verdict IS NULL))) AS eligible
FROM raw CROSS JOIN input
LEFT JOIN LATERAL (
  SELECT h.candidate_id FROM semantic.hidden_candidate h
  WHERE (h.route, h.subject_id, h.candidate_id) = (raw.route, raw.subject_id, raw.candidate_id)
    AND h.route >= input.partition_no * 16 AND h.route < (input.partition_no + 1) * 16
  LIMIT 1
) hidden ON true
LEFT JOIN LATERAL (
  SELECT d.candidate_id, d.account_id, d.disclosed FROM semantic.statement_disclosure d
  WHERE (d.route, d.candidate_id) = (raw.route, raw.candidate_id) AND d.subject_id = raw.subject_id
    AND d.route >= input.partition_no * 16 AND d.route < (input.partition_no + 1) * 16
  LIMIT 1
) disclosure ON true
LEFT JOIN LATERAL (
  SELECT a.verdict FROM semantic.acceptance_current a
  WHERE NOT raw.compact AND (a.route, a.subject_id, a.context_id, a.candidate_id) =
    (raw.route, raw.subject_id, '00000000-0000-8000-8000-000000000000'::uuid, raw.candidate_id)
    AND a.route >= input.partition_no * 16 AND a.route < (input.partition_no + 1) * 16
  LIMIT 1
) accepted ON true
-- An expanded slot needs the proposal origin only in the absence of a verdict.
-- Resolve the candidate by its complete primary key before comparing its slot.
LEFT JOIN LATERAL (
  SELECT c.origin, c.slot_id FROM semantic.candidate c
  WHERE NOT raw.compact AND accepted.verdict IS NULL
    AND (c.route, c.subject_id) = (raw.route, raw.subject_id)
    AND c.candidate_id >= raw.candidate_id AND c.candidate_id <= raw.candidate_id
    AND c.route >= input.partition_no * 16 AND c.route < (input.partition_no + 1) * 16
  ORDER BY c.candidate_id LIMIT 1
) candidate ON candidate.slot_id = raw.slot_id
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
