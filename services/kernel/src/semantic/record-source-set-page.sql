WITH input AS NOT MATERIALIZED (SELECT :key::text AS key)
SELECT s.transaction_id::text AS transaction_id,s.revision::double precision AS revision,
 s.digest,s.members::double precision AS members
FROM semantic.record_source_set_member m CROSS JOIN input
JOIN semantic.record_source_set s ON s.partition_no=m.partition_no AND s.transaction_id=m.transaction_id AND s.sealed
WHERE m.partition_no=:partition::integer AND m.source_hash=sha256(convert_to(input.key,'UTF8')) AND m.source_key=input.key
 AND EXISTS(SELECT 1 FROM core.partition p WHERE p.partition_no=m.partition_no AND p.write_state='active')
 AND m.transaction_id>:after::uuid
ORDER BY m.transaction_id LIMIT :limit::integer;
