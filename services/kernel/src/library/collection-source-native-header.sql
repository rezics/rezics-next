SELECT route, collection_id AS "collectionId", curator_account_id AS "curatorAccountId",
       state, visibility, membership_kind AS "membershipKind", revision,
       created_at::text AS "createdAt", source_generation::text AS "sourceGeneration",
       builtin_kind AS "builtinKind", builtin_release_digest AS "releaseDigest",
       builtin_profile_id AS "profileId", builtin_state_set_id AS "stateSetId", builtin_state_id AS "stateId"
FROM library.collection
WHERE route = $1 AND collection_id = $2;
