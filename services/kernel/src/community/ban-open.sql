-- Seek the full current key within the bound route. The temporal GiST cannot
-- provide this ordered tuple seek. Discard a neighboring key unless both IDs match.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :realm_id::uuid AS realm_id, :account_id::uuid AS account_id,
         :at::timestamptz AS at, :reason::text AS reason, :actor::uuid AS actor,
         :transaction_id::uuid AS transaction_id
), candidate AS MATERIALIZED (
  SELECT b.realm_id, b.account_id, b.valid FROM community.realm_ban b, input i
  WHERE b.route = i.route AND (b.realm_id, b.account_id) >= (i.realm_id, i.account_id)
    AND upper_inf(b.valid)
  ORDER BY b.realm_id, b.account_id
  LIMIT 1
), existing AS (
  SELECT b.* FROM community.realm_ban b, input i
  WHERE b.route = i.route AND b.realm_id = i.realm_id AND b.account_id = i.account_id
    AND b.valid = (
      SELECT c.valid FROM candidate c
      WHERE c.realm_id = i.realm_id AND c.account_id = i.account_id AND c.valid @> i.at
    )
), inserted AS (
  INSERT INTO community.realm_ban (route, realm_id, account_id, valid, reason, actor, transaction_id)
  SELECT route, realm_id, account_id, tstzrange(at, NULL, '[)'), reason, actor, transaction_id
  FROM input WHERE NOT EXISTS (SELECT 1 FROM existing)
  RETURNING *
), chosen AS (
  SELECT * FROM existing UNION ALL SELECT * FROM inserted
)
SELECT lower(valid)::text AS at, reason, actor::text AS actor, transaction_id::text AS "transactionId"
FROM chosen;
