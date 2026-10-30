SELECT s.revision::double precision AS revision,s.digest,s.members::double precision AS members
FROM semantic.record_source_set s JOIN core.partition p ON p.partition_no=s.partition_no AND p.write_state='active'
WHERE s.partition_no=:partition::integer AND s.transaction_id=:transaction::uuid AND s.revision=:revision::integer AND s.sealed;
