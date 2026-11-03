WITH arguments AS MATERIALIZED (
  SELECT :route::integer AS route_id,
         :realm_id::uuid AS realm_id,
         :at::timestamptz AS as_of
),
page AS MATERIALIZED (
  SELECT m.account_id::text AS "accountId",
         m.reservation_id::text AS "reservationId",
         m.transaction_id::text AS "transactionId"
  FROM community.realm_member m
  CROSS JOIN arguments
  WHERE m.route = arguments.route_id AND m.realm_id = arguments.realm_id
    AND upper_inf(m.valid) AND m.valid @> arguments.as_of
    AND m.account_id > :after::uuid
  ORDER BY m.account_id
  LIMIT 20
)
SELECT page.*,
       EXISTS (
         SELECT 1
         FROM community.realm_member next_member
         CROSS JOIN arguments
         WHERE next_member.route = arguments.route_id AND next_member.realm_id = arguments.realm_id
           AND upper_inf(next_member.valid) AND next_member.valid @> arguments.as_of
           AND next_member.account_id > (SELECT page_end."accountId"::uuid FROM page page_end ORDER BY page_end."accountId" DESC LIMIT 1)
       ) AS "hasMore"
FROM page
ORDER BY page."accountId";
