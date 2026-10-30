SELECT c.candidate_id::text AS candidate, c.property, c.slot_id::text AS slot, c.statement, c.release
FROM unnest(:candidate_ids::uuid[]) AS requested(id)
JOIN semantic.candidate c
  ON c.route = :route::integer AND c.subject_id = :subject_id::uuid AND c.candidate_id = requested.id;
