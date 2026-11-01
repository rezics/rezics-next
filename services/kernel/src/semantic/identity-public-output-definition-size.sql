SELECT octet_length(d.capture)+octet_length(d.dependency_keys::text)+2048 AS definition_bytes,
 octet_length(r.body::text)+2048 AS release_bytes
FROM semantic.public_filter_read_definition d
JOIN semantic.definition_release r ON r.route=0 AND r.digest=d.release_digest
WHERE d.partition_no=$1 AND d.read_definition=$2;
