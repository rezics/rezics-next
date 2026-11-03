SELECT candidate_id::text AS "candidateId", slot_id::text AS "slotId", property,
       statement, release, revision, relation
FROM semantic.candidate
WHERE route = :route::integer AND subject_id = :subject_id::uuid
  AND candidate_id = :candidate_id::uuid;
