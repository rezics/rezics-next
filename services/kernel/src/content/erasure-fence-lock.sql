WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), locked AS (
  INSERT INTO content.erasure_fence(route, account_id, closed_at)
  SELECT i.route, i.account_id, NULL FROM input i
  ON CONFLICT (route, account_id) DO UPDATE
    SET account_id = EXCLUDED.account_id
    WHERE false
)
SELECT closed_at::text
FROM content.erasure_fence f CROSS JOIN input i
WHERE f.route = i.route AND f.account_id = i.account_id;
