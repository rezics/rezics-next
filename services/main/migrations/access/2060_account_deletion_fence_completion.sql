-- Ending pages release their own fences. Every other fence, including legacy
-- keep rows and already-completed endings, uses one bounded remaining page.
CREATE INDEX account_deletion_remaining_fence_release
    ON access.account_deletion_progress_agent (operation_id, agent_id)
    WHERE fenced AND (effect <> 'end' OR completed);

-- Older completion released only end and orphan fences. Completed operations
-- carry no authority to prevent the surviving controller from making changes.
UPDATE access.account_deletion_progress_agent a SET fenced = false
    FROM access.account_deletion_progress p
    WHERE p.operation_id = a.operation_id AND p.completed AND a.fenced;

-- A deployment may inherit an unrecorded orphan below its last UUID seek.
-- The pending-effect index excludes recorded rows when the seek restarts.
UPDATE access.account_deletion_progress SET orphan_cursor = NULL WHERE NOT completed;
