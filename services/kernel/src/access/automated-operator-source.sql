-- Exact native command label and eligibility anchors; no private profile inventory.
SELECT kind, state, authn_fenced AS fenced, operator_account_id::text AS "operatorAccountId",
       handle, display_name AS "displayName", transaction_id::text AS revision
FROM access.account
WHERE route = :route AND account_id = :account_id;
