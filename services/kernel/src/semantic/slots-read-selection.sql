SELECT c.*, selected.entry->>'rank' AS adopted_rank
FROM jsonb_array_elements(:selection::jsonb) WITH ORDINALITY AS selected(entry, ordinal)
-- Seek the primary-key suffix before checking equality, including for an absent candidate.
JOIN LATERAL (
  SELECT * FROM semantic.candidate WHERE route = :route::integer AND subject_id = :subject_id::uuid
    AND candidate_id >= (selected.entry->>'candidate')::uuid
  ORDER BY candidate_id LIMIT 1
) c ON c.candidate_id = (selected.entry->>'candidate')::uuid
ORDER BY selected.ordinal;
