WITH page AS MATERIALIZED (
  SELECT m.account_id::text AS "accountId",
         m.reservation_id::text AS "reservationId",
         m.transaction_id::text AS "transactionId"
  FROM community.realm_member m
  WHERE m.route = :route::integer AND m.realm_id = :realm_id::uuid
    AND upper_inf(m.valid) AND m.valid @> :at::timestamptz
    AND m.account_id > :after::uuid
  ORDER BY m.account_id
  LIMIT 20
)
SELECT page.*,
       EXISTS (
         SELECT 1
         FROM community.realm_member next_member
         WHERE next_member.route = :route::integer AND next_member.realm_id = :realm_id::uuid
           AND upper_inf(next_member.valid) AND next_member.valid @> :at::timestamptz
           AND next_member.account_id > (SELECT page_end."accountId"::uuid FROM page page_end ORDER BY page_end."accountId" DESC LIMIT 1)
       ) AS "hasMore"
FROM page
ORDER BY page."accountId";
