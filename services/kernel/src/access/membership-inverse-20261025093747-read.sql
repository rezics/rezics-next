-- No candidate truncation. An absent account and incomplete coverage fail closed.
SELECT a.kind AS "accountKind", a.state, a.authn_fenced AS fenced,
       a.operator_account_id AS "operatorAccountId", a.membership_inverse_complete AS complete,
       i.kind, i.group_id AS id
FROM access.account a
LEFT JOIN access.membership_inverse i ON i.route = a.route AND i.account_id = a.account_id
WHERE a.route = :route AND a.account_id = :account_id
ORDER BY i.kind, i.group_id;
