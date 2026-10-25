SELECT route, account_id AS "accountId", kind, handle, display_name AS "displayName",
       avatar_url AS "avatarUrl", biography, state, operator_account_id AS "operatorAccountId",
       controller_id AS "controllerId", to_char(birth_date, 'YYYY-MM-DD') AS "birthDate",
       content_preferences AS "contentPreferences", suspension_reason AS "suspensionReason",
       minimum_authn_epoch::text AS "minimumAuthnEpoch", authn_fenced AS fenced,
       (extract(epoch FROM created_at) * 1000)::double precision AS "createdAt",
       rate_tier AS "rateTier", transaction_id AS "transactionId"
FROM access.account
WHERE route = :route AND account_id = :account_id;
