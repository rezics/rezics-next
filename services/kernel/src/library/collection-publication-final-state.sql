-- Bounded current owner/rule source fence on the final authorized command transaction.
SELECT curator_account_id::text AS owner,state,membership_kind AS "membershipKind",visibility,revision,
       source_generation::text AS "sourceGeneration",
       collection_id::text || ':' || extract(epoch FROM created_at)::text AS incarnation
FROM library.collection
WHERE route=:route AND collection_id=:collection_id;
