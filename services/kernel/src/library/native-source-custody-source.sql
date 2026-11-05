SELECT curator_account_id::text AS "accountId", collection_id::text || ':' || extract(epoch FROM created_at)::text AS incarnation,
source_generation::text AS generation, state, membership_kind AS kind, builtin_kind AS builtin, visibility,
(rule_filter IS NOT NULL AND rule_sort = 'id' AND rule_release_digest IS NOT NULL) AS "ruleReady"
FROM library.collection WHERE route=:route AND collection_id=:collection_id FOR SHARE;
