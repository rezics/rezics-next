WITH input AS NOT MATERIALIZED (
 SELECT :route::integer AS route,:realm_id::uuid AS realm_id,:account_id::uuid AS account_id,:reservation_id::uuid AS reservation_id
)
, points AS MATERIALIZED (SELECT
 (SELECT m.transaction_id::text FROM community.realm_member m,input i
  WHERE m.route=i.route AND m.realm_id=i.realm_id AND m.account_id=i.account_id
    AND upper_inf(m.valid) AND m.reservation_id=i.reservation_id) AS "publicationTransactionId",
 (SELECT t.transaction_id::text FROM community.realm_member_terminal t,input i
  WHERE t.route=i.route AND t.realm_id=i.realm_id AND t.account_id=i.account_id AND t.reservation_id=i.reservation_id) AS "terminalTransactionId",
 EXISTS (SELECT 1 FROM community.realm_member m,input i
  WHERE m.route=i.route AND m.realm_id=i.realm_id AND m.account_id=i.account_id AND m.reservation_id=i.reservation_id) AS history
)
SELECT p.*, EXISTS (
 SELECT 1 FROM core.receipt r,input i
 WHERE r.partition_no=(i.route >> 4)
 AND r.transaction_id=COALESCE(p."publicationTransactionId",p."terminalTransactionId")::uuid
 AND r.command_kind IN ('community.realm.membership','community.realm.membership.terminal','community.realm.membership.cancel')
 AND r.response->>'realmId'=i.realm_id::text AND r.response->>'accountId'=i.account_id::text
 AND r.response->>'reservationId'=i.reservation_id::text
 AND (p."publicationTransactionId" IS NULL OR r.response->>'role'='member')
) AS committed FROM points p;
