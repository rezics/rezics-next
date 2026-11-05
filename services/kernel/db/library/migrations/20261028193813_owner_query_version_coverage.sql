-- migrate:up
-- Extend the existing Everything/state fence to every observable native row change.
-- dbmate applies this entire migration atomically: writers have no uncovered window.
-- Keep insert/delete hooks, owner routing, PK and bigint overflow semantics unchanged.
DROP TRIGGER entry_fact_source_update ON library.entry;
CREATE TRIGGER entry_fact_source_update
  AFTER UPDATE ON library.entry
  FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW)
  EXECUTE FUNCTION library.advance_fact_source_head();

DROP TRIGGER copy_fact_source_update ON library.copy;
CREATE TRIGGER copy_fact_source_update
  AFTER UPDATE ON library.copy
  FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW)
  EXECUTE FUNCTION library.advance_fact_source_head();

DROP TRIGGER progress_session_fact_source_update ON library.progress_session;
CREATE TRIGGER progress_session_fact_source_update
  AFTER UPDATE ON library.progress_session
  FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW)
  EXECUTE FUNCTION library.advance_fact_source_head();

DROP TRIGGER label_assignment_fact_source_update ON library.label_assignment;
CREATE TRIGGER label_assignment_fact_source_update
  AFTER UPDATE ON library.label_assignment
  FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW)
  EXECUTE FUNCTION library.advance_fact_source_head();

DROP TRIGGER personal_label_fact_source_update ON library.personal_label;
CREATE TRIGGER personal_label_fact_source_update
  AFTER UPDATE ON library.personal_label
  FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW)
  EXECUTE FUNCTION library.advance_fact_source_head();

-- No backfill, fact copy, bootstrap/readiness claim or state-write allocation.
-- Genuine SQL no-change updates do not fire; each changed row pays its own hook cost.
-- migrate:down
-- Forward only: never reopen incomplete owner-query invalidation coverage.
