SELECT account_id AS "accountId", kind, state,
       CASE WHEN state <> 'deleted' THEN handle END AS handle,
       CASE WHEN state <> 'deleted' THEN display_name END AS "displayName",
       CASE WHEN state <> 'deleted' THEN avatar_url END AS "avatarUrl",
       CASE WHEN state <> 'deleted' THEN biography END AS biography,
       CASE WHEN state <> 'deleted' THEN operator_account_id END AS "operatorAccountId"
FROM access.account
WHERE route = :route AND account_id = :account_id AND state <> 'pending';
