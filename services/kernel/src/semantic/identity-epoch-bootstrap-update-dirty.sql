WITH captured AS MATERIALIZED (
  SELECT r.source_revision,k.ctid
  FROM jsonb_to_recordset($1::jsonb) AS r(route integer,original uuid,source_revision bigint)
  CROSS JOIN LATERAL (
    SELECT d.ctid FROM semantic.identity_epoch_dirty d
    WHERE (d.route,d.original)=(r.route,r.original) AND d.revision>=r.source_revision
      AND d.captured_revision<r.source_revision LIMIT 1 FOR UPDATE
  ) k
)
UPDATE semantic.identity_epoch_dirty d SET captured_revision=c.source_revision
FROM captured c WHERE d.ctid=c.ctid;
