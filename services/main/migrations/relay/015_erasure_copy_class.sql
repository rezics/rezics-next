-- Destruction of an inventoried copy is unverified until its owner supplies
-- evidence. This is a per-copy status; the erasure header still treats it as
-- retained so an unknown snapshot or media copy cannot be reported destroyed.
ALTER TABLE relay.retention_domain DROP CONSTRAINT retention_domain_store_check;
ALTER TABLE relay.retention_domain ADD CONSTRAINT retention_domain_store_check
  CHECK (store IN ('postgresql', 'postgresql_wal', 'tdb2', 'tdb2_generation',
    'lucene', 'object_store', 'cache', 'delivery', 'log', 'audit',
    'export_artifact', 'snapshot', 'media'));

ALTER TABLE relay.erasure_disposition DROP CONSTRAINT erasure_disposition_destruction_check;
ALTER TABLE relay.erasure_disposition ADD CONSTRAINT erasure_disposition_destruction_check
  CHECK (destruction IN ('pending', 'not_present', 'destroyed', 'sanitized',
    'expired', 'retained', 'blocked', 'unverified'));
ALTER TABLE relay.erasure_disposition ADD CONSTRAINT erasure_disposition_unverified_reason
  CHECK (destruction <> 'unverified' OR reason IS NOT NULL);
