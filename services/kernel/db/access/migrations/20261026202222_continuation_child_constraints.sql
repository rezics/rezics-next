-- migrate:up
-- Entries are inserted through the root's foreign-keyed fan-out page, and completions
-- follow exact root membership checks. Roots and their children are immutable.
-- Keep the Access foreign-key surface at the root/account and page/root boundaries.
ALTER TABLE access.committed_continuation_completion
  DROP CONSTRAINT committed_continuation_completion_route_continuation_id_fkey;
ALTER TABLE access.committed_continuation_entry
  DROP CONSTRAINT committed_continuation_entry_route_continuation_id_fkey;

-- migrate:down
ALTER TABLE access.committed_continuation_completion
  ADD FOREIGN KEY (route, continuation_id) REFERENCES access.committed_continuation (route, continuation_id);
ALTER TABLE access.committed_continuation_entry
  ADD FOREIGN KEY (route, continuation_id) REFERENCES access.committed_continuation (route, continuation_id);
