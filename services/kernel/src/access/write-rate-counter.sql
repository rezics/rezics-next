INSERT INTO access.write_rate_counter AS counter (route, identity_digest, family, count, expires_at)
VALUES (:route::integer, :identity_digest::text, :family::text, :admitted_units::integer,
        statement_timestamp() + :seconds::integer * interval '1 second')
ON CONFLICT (route, identity_digest, family) DO UPDATE
SET count = CASE
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
