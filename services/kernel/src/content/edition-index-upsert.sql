INSERT INTO content.creator_edition(route, creator_account_id, edition_id)
VALUES (:route::integer, :creator_account_id::uuid, :edition_id::uuid)
ON CONFLICT (route, creator_account_id, edition_id) DO NOTHING
RETURNING edition_id;
