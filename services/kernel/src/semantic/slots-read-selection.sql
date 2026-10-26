SELECT c.*, selected.entry->>'rank' AS adopted_rank
FROM jsonb_array_elements(:selection::jsonb) WITH ORDINALITY AS selected(entry, ordinal)
JOIN LATERAL (SELECT * FROM semantic.candidate WHERE route = :route::integer AND subject_id = :subject_id::uuid
  AND candidate_id = (selected.entry->>'candidate')::uuid LIMIT 1) c ON true
ORDER BY selected.ordinal;
