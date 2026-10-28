SELECT route, collection_id AS "collectionId", account_id AS "accountId",
       profile_id AS "profileId", state_set_id AS "stateSetId", state_id AS "stateId"
FROM library.builtin_collection_reference
WHERE route = :route AND collection_id = :collection_id;
