SELECT rule_filter::text AS filter, rule_sort AS sort, rule_release_digest AS "releaseDigest",
       rule_source AS source,
       rule_revision::text AS "ruleRevision", revision AS "collectionRevision", source_generation::text AS "sourceGeneration"
FROM library.collection
WHERE route = :route AND collection_id = :collection_id
  AND state = 'active' AND membership_kind = 'dynamic' AND builtin_kind IS NULL
  AND rule_filter IS NOT NULL AND rule_sort IS NOT NULL AND rule_release_digest IS NOT NULL;
