-- A later suspension supersedes the old fanout even if it was also reversed.
-- Other authentication-floor changes do not supersede a suspension reversal.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
)
SELECT a.account_id
FROM input i JOIN access.account a ON a.route = i.route AND a.account_id = i.account_id
WHERE a.state = :state::text AND (
  SELECT c.continuation_id FROM access.committed_continuation c
  WHERE c.route = i.route AND c.account_id = i.account_id
    AND c.allowlist @> '[{"step":"operator-responsibility-page"}]'::jsonb
  ORDER BY c.minimum_authn_epoch DESC LIMIT 1
) = :continuation_id::uuid
FOR UPDATE OF a;
