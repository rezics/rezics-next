-- migrate:up
-- Physical removal of a hidden fact is not another logical membership transition.
-- Keep live legacy deletes conservative; ordinary purge always holds the deleted parent.
CREATE FUNCTION library.advance_live_label_assignment_delete_source_head() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM library.personal_label
    WHERE route = OLD.route AND account_id = OLD.account_id AND label_id = OLD.label_id
      AND deleted_at IS NULL
  ) THEN
    INSERT INTO library.fact_source_head AS head (route, account_id, generation)
      VALUES (OLD.route, OLD.account_id, 1)
      ON CONFLICT (route, account_id) DO UPDATE SET generation = head.generation + 1;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER label_assignment_fact_source_rows ON library.label_assignment;
CREATE TRIGGER label_assignment_fact_source_rows
  AFTER INSERT ON library.label_assignment
  FOR EACH ROW EXECUTE FUNCTION library.advance_fact_source_head();
CREATE TRIGGER label_assignment_fact_source_delete
  AFTER DELETE ON library.label_assignment
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND OLD.slot_no IS NOT NULL)
  EXECUTE FUNCTION library.advance_live_label_assignment_delete_source_head();
DROP TRIGGER personal_label_fact_source_delete ON library.personal_label;
CREATE TRIGGER personal_label_fact_source_delete
  AFTER DELETE ON library.personal_label
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL)
  EXECUTE FUNCTION library.advance_fact_source_head();

-- migrate:down
-- Forward only: physical cleanup must never invalidate membership twice.
