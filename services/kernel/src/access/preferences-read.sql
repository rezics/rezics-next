SELECT spoiler_level AS "spoilerLevel", suitability, shelf, version
FROM access.account_preferences
WHERE route = :route::integer AND account_id = :account_id::uuid;
