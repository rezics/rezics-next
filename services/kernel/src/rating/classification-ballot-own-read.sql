SELECT binding_hash, assessment, false_positive AS "falsePositive",
       revision::text AS revision, eligibility_generation::text AS "eligibilityGeneration",
       eligible
FROM rating.classification_ballot
WHERE route = :route::integer AND actor_id = :actor_id::uuid
  AND subject_id = :subject_id::uuid AND association_id = :association_id::uuid;
