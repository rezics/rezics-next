INSERT INTO rating.classification_ballot
  (route, actor_id, subject_id, association_id, binding_hash, assessment,
   false_positive, revision, eligibility_generation, eligible)
VALUES (:route::integer, :actor_id::uuid, :subject_id::uuid, :association_id::uuid,
        :binding_hash::bytea, :assessment::text, :false_positive::boolean,
        :revision::bigint, :eligibility_generation::bigint, :eligible::boolean)
ON CONFLICT (route, actor_id, subject_id, association_id) DO UPDATE
SET binding_hash = EXCLUDED.binding_hash,
    assessment = EXCLUDED.assessment,
    false_positive = EXCLUDED.false_positive,
    revision = EXCLUDED.revision,
    eligibility_generation = EXCLUDED.eligibility_generation,
    eligible = EXCLUDED.eligible
RETURNING revision::text AS revision;
