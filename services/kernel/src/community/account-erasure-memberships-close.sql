-- Empty same-T intervals are removed by the following purge, as in membership-close.sql.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :realm_id::uuid AS realm_id, :account_id::uuid AS account_id,
         :at::timestamptz AS at, :transaction_id::uuid AS transaction_id
), authority AS MATERIALIZED (
  SELECT input.*, set_config('community.member_erasure_account', input.account_id::text, true)
  FROM input
)
UPDATE community.realm_member m
SET valid = tstzrange(lower(m.valid), i.at, '[)'), transaction_id = i.transaction_id
FROM authority i
WHERE m.route = i.route AND m.realm_id = i.realm_id AND m.account_id = i.account_id
  AND m.valid @> i.at AND (lower_inf(m.valid) OR lower(m.valid) < i.at);
