WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :realm_id::uuid AS realm_id, :account_id::uuid AS account_id
), authority AS MATERIALIZED (
  SELECT input.*, set_config('community.member_erasure_account', input.account_id::text, true)
  FROM input
), intervals AS (
  DELETE FROM community.realm_member m USING authority i
  WHERE m.route = i.route AND m.realm_id = i.realm_id AND m.account_id = i.account_id
-- Accounts only commits the terminal erasure obligation after its exact
-- membership transition proofs have been consumed. These Community-owned
-- proofs are part of the same account's membership history and share its Realm locator.
), proofs AS (
  DELETE FROM community.realm_membership_proof p USING authority i
  WHERE p.route = i.route AND p.realm_id = i.realm_id AND p.account_id = i.account_id
)
DELETE FROM community.realm_member_terminal t USING authority i
WHERE t.route = i.route AND t.realm_id = i.realm_id AND t.account_id = i.account_id;
