WITH stored AS MATERIALIZED (
 SELECT curator_account_id::text AS "accountId",
  collection_id::text || ':' || extract(epoch FROM created_at)::text AS incarnation,
  source_generation::text AS generation,state,membership_kind AS kind,builtin_kind AS builtin,visibility,
  (rule_filter IS NOT NULL AND rule_sort='id' AND rule_release_digest IS NOT NULL) AS "ruleReady"
 FROM library.collection WHERE route=:route AND collection_id=:collection_id
   AND collection_id::text || ':' || extract(epoch FROM created_at)::text=:incarnation
 FOR SHARE
), logical AS MATERIALIZED (
 SELECT account_id::text,incarnation,generation::text,'active','dynamic','everything','private',false
 FROM library.logical_everything_source
 WHERE NOT :retained::boolean AND route=:route AND collection_id=:collection_id AND incarnation=:incarnation
 FOR SHARE
), held_owner AS MATERIALIZED (
 -- Release/revalidate only an existing exact obligation after a source change or materialization.
 SELECT account_id::text,:incarnation,generation::text,'active','dynamic','everything','private',false
 FROM library.fact_source_head WHERE :retained::boolean AND route=:route AND account_id=:account_id
   AND library.everything_source_id(account_id)=:collection_id
   AND :incarnation=:collection_id::uuid::text || ':everything'
 FOR SHARE
)
SELECT * FROM stored UNION ALL SELECT * FROM logical UNION ALL SELECT * FROM held_owner;
