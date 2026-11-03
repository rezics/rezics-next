DELETE FROM library.shelf_score_head
WHERE route=:route::integer AND account_id=:account_id::uuid
RETURNING true AS removed;
