SELECT route, collection_id AS "collectionId", curator_account_id AS "curatorAccountId",
       state, visibility, membership_kind AS "membershipKind", revision,
       extract(epoch FROM created_at)::text AS "createdAt", source_generation::text AS "sourceGeneration",
       builtin_kind AS "builtinKind", COALESCE(builtin_release_digest, rule_release_digest) AS "releaseDigest",
       builtin_profile_id AS "profileId", builtin_state_set_id AS "stateSetId", builtin_state_id AS "stateId",
       rule_revision::text AS "ruleRevision", rule_release_digest AS "ruleReleaseDigest",
       (rule_filter IS NOT NULL AND rule_sort = 'id' AND rule_release_digest IS NOT NULL) AS "ruleReady"
FROM library.collection
WHERE route = :route AND collection_id = :collection_id;
