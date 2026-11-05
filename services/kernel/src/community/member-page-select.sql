WITH page_args AS MATERIALIZED (
  SELECT :route::integer AS arg_route,
         :realm_id::uuid AS arg_realm_id,
         :at::timestamptz AS arg_at,
         :after::uuid AS arg_after
), page AS MATERIALIZED (
  SELECT m.account_id::text AS "accountId",
         m.reservation_id::text AS "reservationId",
         m.transaction_id::text AS "transactionId"
  FROM community.realm_member m
  CROSS JOIN page_args args
  WHERE m.route = args.arg_route AND m.realm_id = args.arg_realm_id
    AND upper_inf(m.valid) AND m.valid @> args.arg_at
    AND m.account_id > args.arg_after
  ORDER BY m.account_id
  LIMIT 20
)
SELECT page.*,
       EXISTS (
         SELECT 1
         FROM community.realm_member next_member
         CROSS JOIN page_args args
         WHERE next_member.route = args.arg_route AND next_member.realm_id = args.arg_realm_id
           AND upper_inf(next_member.valid) AND next_member.valid @> args.arg_at
           AND next_member.account_id > (SELECT page_end."accountId"::uuid FROM page page_end ORDER BY page_end."accountId" DESC LIMIT 1)
       ) AS "hasMore"
FROM page
ORDER BY page."accountId";
