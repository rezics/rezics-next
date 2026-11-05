SELECT partition_no, revision::text, "current", fence, verified, covered_through, attempt
FROM search.index_home_coverage
WHERE partition_no = :partition AND consumer = :consumer AND index_uuid = :uuid
FOR UPDATE;
