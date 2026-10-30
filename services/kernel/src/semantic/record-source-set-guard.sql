SELECT revision::double precision AS revision,digest,members::double precision AS members
FROM semantic.record_source_set
WHERE partition_no=:partition::integer AND transaction_id=:transaction::uuid AND revision=:revision::integer
 AND sealed AND native_xid=pg_current_xact_id()::text;
