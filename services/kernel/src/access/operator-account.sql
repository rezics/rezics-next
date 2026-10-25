SELECT account_id AS "accountId", kind, state, operator_account_id AS "operatorAccountId",
       minimum_authn_epoch::text AS "minimumAuthnEpoch", authn_fenced AS fenced,
       operator_relation_version::text AS version, operator_reservation_id AS "reservationId",
       clock_timestamp()::text AS "observedAt"
FROM access.account
WHERE route = :route AND account_id = :account_id
FOR UPDATE;
