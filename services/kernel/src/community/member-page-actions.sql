WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :realm_id::uuid AS realm_id,
         :account_ids::uuid[] AS account_ids, :at::timestamptz AS at
), ids AS MATERIALIZED (
  SELECT DISTINCT i.route, i.realm_id, i.at, account_id
  FROM input i CROSS JOIN LATERAL unnest(i.account_ids) AS requested(account_id)
)
SELECT i.account_id::text AS "accountId",
       EXISTS (
         SELECT 1 FROM community.realm_ban b
         WHERE b.route = i.route AND b.realm_id = i.realm_id AND b.account_id = i.account_id
           AND upper_inf(b.valid) AND b.valid @> i.at
       ) AS banned
FROM ids i
ORDER BY i.account_id;
