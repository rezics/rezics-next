-- Read the open interval through the covering current index, then update that
-- exact temporal key. A scalar subquery prevents a join from scanning history.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :realm_id::uuid AS realm_id, :account_id::uuid AS account_id,
         :at::timestamptz AS at
), candidate AS MATERIALIZED (
  SELECT b.realm_id, b.account_id, b.valid FROM community.realm_ban b, input i
  WHERE b.route = i.route AND (b.realm_id, b.account_id) >= (i.realm_id, i.account_id)
    AND upper_inf(b.valid)
  ORDER BY b.realm_id, b.account_id
  LIMIT 1
)
UPDATE community.realm_ban b
SET valid = tstzrange(lower(b.valid), i.at, '[)')
FROM input i
WHERE b.route = i.route AND b.realm_id = i.realm_id AND b.account_id = i.account_id
  AND b.valid = (
    SELECT c.valid FROM candidate c
    WHERE c.realm_id = i.realm_id AND c.account_id = i.account_id
      AND c.valid @> i.at AND lower(c.valid) < i.at
  )
RETURNING b.account_id::text AS "accountId";
