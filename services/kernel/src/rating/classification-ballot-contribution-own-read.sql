SELECT binding_hash AS "bindingHash", revision::text AS revision
FROM rating.classification_contribution
WHERE route = :route::integer AND subject_id = :subject_id::uuid
  AND association_id = :association_id::uuid AND actor_route = :actor_route::integer
  AND actor_id = :actor_id::uuid;
