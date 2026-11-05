WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :realm_id::uuid AS realm_id,
         :account_ids::uuid[] AS account_ids, :at::timestamptz AS at
), ids AS MATERIALIZED (
  SELECT i.route, i.realm_id, i.at, account_id
  FROM input i CROSS JOIN LATERAL unnest(i.account_ids) AS requested(account_id)
)
SELECT i.account_id::text AS "accountId",
       m.reservation_id::text AS "reservationId",
       m.transaction_id::text AS "transactionId",
       EXISTS (
         SELECT 1
         FROM community.realm_membership_proof p
         JOIN core.receipt r
           ON r.partition_no = (i.route >> 4)
          AND r.principal_kind = 'account'
          AND r.principal_id = p.principal_id
          AND r.command_kind = p.command_kind
          AND r.idempotency_key = p.command_key
          AND r.transaction_id = p.transaction_id
          AND r.response->>'realmId' = p.realm_id::text
          AND r.response->>'accountId' = p.account_id::text
          AND r.response->>'reservationId' = p.reservation_id::text
          AND r.response->>'publicationTransactionId' = p.publication_transaction_id::text
          AND r.response->'transition'->>'generationId' = p.generation_id::text
          AND r.response->'transition'->>'operationId' = p.operation_id
          AND r.response->'transition'->>'outcome' = p.outcome
         WHERE p.route = i.route AND p.realm_id = i.realm_id AND p.account_id = i.account_id
           AND p.reservation_id = m.reservation_id
           AND p.transaction_id = m.transaction_id
           AND p.publication_transaction_id = m.transaction_id
           AND p.outcome = 'published'
         LIMIT 1
       ) AS committed,
       EXISTS (
         SELECT 1 FROM community.realm_member_terminal t
         WHERE t.route = i.route AND t.realm_id = i.realm_id
           AND t.account_id = i.account_id AND t.reservation_id = m.reservation_id
       ) AS terminalized
FROM ids i
JOIN LATERAL (
  SELECT current_member.reservation_id, current_member.transaction_id
  FROM community.realm_member current_member
  WHERE current_member.route = i.route AND current_member.realm_id = i.realm_id
    AND current_member.account_id = i.account_id
    AND upper_inf(current_member.valid) AND current_member.valid @> i.at
  LIMIT 1
) m ON true;
