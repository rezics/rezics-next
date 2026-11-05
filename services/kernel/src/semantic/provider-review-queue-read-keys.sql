SELECT subject_id::text, candidate_id::text
FROM semantic.provider_review_queue_entry
WHERE route=0 AND source=:source::text
  AND (subject_id,candidate_id)>(:after_subject::uuid,:after_candidate::uuid)
ORDER BY subject_id,candidate_id LIMIT 100;
