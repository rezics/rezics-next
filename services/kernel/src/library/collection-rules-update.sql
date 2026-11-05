UPDATE library.collection
SET rule_filter = :filter::text::jsonb, rule_sort = :sort, rule_source = :source, rule_release_digest = :release_digest,
    rule_revision = rule_revision + 1, revision = revision + 1, source_generation = source_generation + 1,
    updated_at = :time::timestamptz, transaction_id = :transaction_id
WHERE route = :route AND collection_id = :collection_id AND revision = :revision
  AND state = 'active' AND membership_kind = 'dynamic' AND builtin_kind IS NULL AND rule_filter IS NOT NULL
RETURNING revision;
