SELECT kind AS "accountKind", state, authn_fenced AS fenced,
       operator_account_id AS "operatorAccountId", membership_inverse_complete AS complete,
       minimum_authn_epoch::text AS "minimumAuthnEpoch"
FROM access.account
WHERE route = :route::integer AND account_id = :account_id::uuid
LIMIT 1;
