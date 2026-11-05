SELECT curator_account_id::text AS "accountId", state, membership_kind AS "membershipKind", visibility,
       revision, source_generation::text AS "sourceGeneration",
       collection_id::text || ':' || extract(epoch FROM created_at)::text AS incarnation
FROM library.collection
WHERE route=$1 AND collection_id=$2
FOR UPDATE;
