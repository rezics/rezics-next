SELECT account.state, preferences.notifications
FROM access.account AS account
LEFT JOIN access.account_preferences AS preferences USING (route, account_id)
WHERE account.route = :route::integer AND account.account_id = :account_id::uuid;
