INSERT INTO rating.classification_contribution
  (route, subject_id, association_id, binding_hash, actor_route, actor_id, assessment,
   false_positive, revision, source_epoch, source_position, eligibility_generation, eligible)
VALUES (:route::integer, :subject_id::uuid, :association_id::uuid, :binding_hash::bytea,
        :actor_route::integer, :actor_id::uuid, :assessment::text, :false_positive::boolean,
        :revision::bigint, :source_epoch::integer, :source_position::bigint,
        :eligibility_generation::bigint, :eligible::boolean)
ON CONFLICT (route, subject_id, association_id, actor_route, actor_id) DO UPDATE
SET assessment = EXCLUDED.assessment,
    false_positive = EXCLUDED.false_positive,
    revision = EXCLUDED.revision,
    source_epoch = EXCLUDED.source_epoch,
    source_position = EXCLUDED.source_position,
    eligibility_generation = EXCLUDED.eligibility_generation,
    eligible = EXCLUDED.eligible
WHERE rating.classification_contribution.binding_hash = EXCLUDED.binding_hash;
