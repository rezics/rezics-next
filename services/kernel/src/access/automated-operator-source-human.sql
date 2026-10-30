-- Current genuine initiating human and floor, never returned to the browser.
SELECT kind, state, authn_fenced AS fenced, operator_account_id::text AS "operatorAccountId",
       minimum_authn_epoch::text AS floor, transaction_id::text AS revision
FROM access.account
WHERE route = :route AND account_id = :account_id;
