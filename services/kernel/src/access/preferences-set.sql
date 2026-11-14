INSERT INTO access.account_preferences (route, account_id, spoiler_level, suitability, shelf, editor, notifications, version)
VALUES (:route::integer, :account_id::uuid, :spoiler_level::integer, :suitability::text, :shelf::jsonb, :editor::jsonb, :notifications::jsonb, 1)
ON CONFLICT (route, account_id) DO UPDATE
SET spoiler_level = EXCLUDED.spoiler_level, suitability = EXCLUDED.suitability, shelf = EXCLUDED.shelf,
    editor = EXCLUDED.editor,
    notifications = EXCLUDED.notifications,
    version = access.account_preferences.version + 1
WHERE access.account_preferences.version = :expected_version::integer
RETURNING version;
