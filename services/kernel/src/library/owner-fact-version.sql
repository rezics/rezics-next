SELECT generation
FROM library.fact_source_head
WHERE route = :route AND account_id = :account_id;
