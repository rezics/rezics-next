SELECT curator_account_id::text AS "accountId", source_generation::text AS "sourceGeneration",
       state, presentation_kind AS "presentationKind"
FROM library.collection
WHERE route=:route::integer AND collection_id=:collection_id::uuid
LIMIT 1 FOR UPDATE;
