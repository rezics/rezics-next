WITH input AS NOT MATERIALIZED (SELECT :partition::integer AS partition),
requested AS MATERIALIZED (
  SELECT route, account_id FROM unnest(:routes::integer[], :account_ids::uuid[]) AS ids(route, account_id)
)
SELECT account.account_id AS "accountId",
       jsonb_build_object(
         'posts', account.public_views->'posts',
         'reviews', account.public_views->'reviews',
         'collections', account.public_views->'collections'
       ) AS "publicViews"
FROM requested CROSS JOIN input i
CROSS JOIN LATERAL (
  SELECT candidate.account_id, candidate.public_views
  FROM access.account AS candidate
  WHERE candidate.route = requested.route AND candidate.account_id = requested.account_id
    AND candidate.route >= i.partition * 16 AND candidate.route < (i.partition + 1) * 16
    AND candidate.state = 'active' AND NOT candidate.authn_fenced
  LIMIT 1
) AS account;
