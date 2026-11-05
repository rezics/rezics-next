WITH identity AS MATERIALIZED (
  SELECT :route::integer AS route, NULLIF(:account_id::text, '')::uuid AS account_id
), account_lock AS MATERIALIZED (
  -- Serialize authenticated charges with the permanent deletion barrier. An
  -- already authenticated pre-T context cannot repopulate a purged rate row.
  SELECT a.account_id FROM access.account a, identity i
  WHERE a.route=i.route AND a.account_id=i.account_id AND a.state<>'deleted'
    AND NOT EXISTS (SELECT 1 FROM access.erasure e WHERE e.route=i.route AND e.account_id=i.account_id)
  FOR SHARE OF a
)
INSERT INTO access.write_rate_counter AS counter (route, identity_digest, family, count, expires_at, account_id)
SELECT i.route, :identity_digest::text, :family::text, :admitted_units::integer,
       statement_timestamp() + :seconds::integer * interval '1 second', i.account_id
FROM identity i WHERE i.account_id IS NULL OR EXISTS (SELECT 1 FROM account_lock)
ON CONFLICT (route, identity_digest, family) DO UPDATE
SET account_id = EXCLUDED.account_id,
    count = CASE
      WHEN counter.expires_at <= statement_timestamp() THEN EXCLUDED.count
      WHEN counter.count <= :maximum::integer - EXCLUDED.count THEN counter.count + EXCLUDED.count
      ELSE counter.count
    END,
    expires_at = CASE
      WHEN counter.expires_at <= statement_timestamp() THEN EXCLUDED.expires_at
      ELSE counter.expires_at
    END
-- OLD is the row locked by ON CONFLICT, including concurrent spends. A positive
-- initial/reset count or an increase admits the entire batch; zero never does.
RETURNING count > 0 AND (
    OLD.identity_digest IS NULL OR OLD.expires_at <= statement_timestamp() OR count > OLD.count
  ) AS allowed,
  GREATEST(1, ceil(extract(epoch FROM expires_at - statement_timestamp())))::integer AS "retryAfter";
