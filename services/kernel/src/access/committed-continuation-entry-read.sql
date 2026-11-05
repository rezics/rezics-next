SELECT digest
FROM access.committed_continuation_entry
WHERE route = :route AND continuation_id = :continuation_id
  AND step = :step AND target = :target AND key = :key AND digest = :digest;
