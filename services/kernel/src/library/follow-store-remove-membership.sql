DELETE FROM library.follow
WHERE route = :route::integer AND account_id = :account_id::uuid AND target_id = :target_id::uuid
  AND target_type = 'space' AND reason = 'membership'
RETURNING true AS changed;
