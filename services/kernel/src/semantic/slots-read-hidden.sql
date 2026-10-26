SELECT probed.candidate_id::text AS candidate_id
FROM unnest(:candidate_ids::uuid[]) AS wanted(candidate_id)
JOIN LATERAL (
  SELECT candidate_id FROM semantic.hidden_candidate
  WHERE route = :route::integer AND subject_id = :subject_id::uuid AND candidate_id = wanted.candidate_id
  OFFSET 0
  LIMIT 1
) probed ON true;
