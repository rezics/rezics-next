-- Cost metadata only, in the same RR snapshot as the released source observation.
-- No full Type or partition address crosses this size point.
SELECT (SELECT octet_length(node) + COALESCE(octet_length(moved_to), 0)
        FROM core.partition WHERE partition_no = :partition_no::integer) AS partition_bytes,
       (SELECT octet_length(type) FROM semantic.subject
        WHERE route = :route::integer AND subject_id = :subject_id::uuid AND visibility = 'visible') AS type_bytes;
