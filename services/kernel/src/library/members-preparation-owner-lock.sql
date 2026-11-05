SELECT live_count AS "liveCount" FROM library.members_preparation_owner
WHERE route = :route::integer AND owner_account_id = :owner_account_id::uuid
FOR UPDATE;
