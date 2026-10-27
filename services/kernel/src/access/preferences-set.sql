INSERT INTO access.account_preferences (route, account_id, spoiler_level, suitability, shelf, version)
VALUES (:route::integer, :account_id::uuid, :spoiler_level::integer, :suitability::text, :shelf::jsonb, 1)
ON CONFLICT (route, account_id) DO UPDATE
SET spoiler_level = EXCLUDED.spoiler_level, suitability = EXCLUDED.suitability, shelf = EXCLUDED.shelf,
    version = access.account_preferences.version + 1
WHERE access.account_preferences.version = :expected_version::integer
RETURNING version;
