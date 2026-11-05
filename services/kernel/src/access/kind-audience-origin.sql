-- Exact active original episode. Locks are retained through original evaluation and commit.
SELECT observation.generation::text AS "preparationId",
       observation.source_generation::text AS "sourceGeneration",
       observation.capture, observation.version::text AS version,
       observation.frontier, observation.after_subject::text AS "afterSubject",
       observation.complete, collection.visibility, collection.membership_kind AS "membershipKind"
FROM library.collection_kind_observation AS observation
JOIN library.collection AS collection
  ON (collection.route,collection.collection_id,collection.curator_account_id)=
     (observation.route,observation.collection_id,observation.account_id)
JOIN access.account AS owner
  ON (owner.route,owner.account_id)=(observation.route,observation.account_id)
JOIN core.partition AS home ON home.partition_no=(observation.route >> 4)
WHERE observation.route=:route::integer AND observation.collection_id=:collection_id::uuid
  AND observation.account_id=:owner_account_id::uuid AND observation.audience=:audience::text
  AND observation.generation=:preparation_id::uuid
  AND collection.state='active' AND collection.presentation_kind IS NULL
  AND collection.source_generation=observation.source_generation
  AND owner.state='active' AND NOT owner.authn_fenced AND home.write_state='active'
LIMIT 1
FOR UPDATE OF observation,collection FOR SHARE OF owner,home;
