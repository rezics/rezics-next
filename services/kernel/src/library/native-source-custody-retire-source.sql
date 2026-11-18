-- Same native owner lock as ordinary cleanup; generation is current, not the old capture generation.
WITH stored AS MATERIALIZED (
SELECT curator_account_id::text AS "accountId",
 collection_id::text || ':' || extract(epoch FROM created_at)::text AS incarnation,
 source_generation::text AS generation, state, membership_kind AS kind, builtin_kind AS builtin,
 visibility, deletion_id::text AS "deletionId", revision,
 purge_after = :purge_after::nullable(timestamptz) AS "deadlineMatches",
 deleted_at IS NOT NULL AND purge_after = deleted_at + interval '720 hours'
 AND purge_after <= :time::timestamptz AS due,
 EXISTS (SELECT 1 FROM library.collection_source_output o
   WHERE o.route=collection.route AND o.collection_id=collection.collection_id)
 OR visibility='public' OR listing_ever_public OR EXISTS (
   SELECT 1 FROM library.collection_listing_history h
   WHERE h.route=collection.route AND h.collection_id=collection.collection_id
 ) AS "publicCustody"
FROM library.collection WHERE route=:route AND collection_id=:collection_id AND collection_id::text || ':' || extract(epoch FROM created_at)::text=:incarnation FOR UPDATE
), logical AS MATERIALIZED (
 SELECT account_id::text,:incarnation,generation::text,'active','dynamic','everything','private',
   NULL::text,0,NULL::boolean,false,false
 FROM library.fact_source_head WHERE route=:route AND account_id=:account_id
   AND library.everything_source_id(account_id)=:collection_id
   AND :incarnation=:collection_id::uuid::text || ':everything'
 FOR UPDATE
)
SELECT * FROM stored UNION ALL SELECT * FROM logical;
