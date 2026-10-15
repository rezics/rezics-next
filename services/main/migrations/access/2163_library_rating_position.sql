-- A principal point-read replaces an inventory-sized digest on every export
-- page. Trigger with the completeness witnesses so all rating writers and
-- erasure share the same committed position.
ALTER TABLE access.principal ADD COLUMN library_rating_version bigint NOT NULL DEFAULT 0;
CREATE FUNCTION access.advance_library_rating_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    UPDATE access.principal SET library_rating_version=library_rating_version+1 WHERE id=OLD.principal_id;
  END IF;
  IF TG_OP<>'DELETE' AND (TG_OP='INSERT' OR NEW.principal_id IS DISTINCT FROM OLD.principal_id) THEN
    UPDATE access.principal SET library_rating_version=library_rating_version+1 WHERE id=NEW.principal_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER library_rating_version AFTER INSERT OR UPDATE OR DELETE ON access.rating_aggregate_head
  FOR EACH ROW EXECUTE FUNCTION access.advance_library_rating_version();
CREATE TRIGGER library_target_rating_version AFTER INSERT OR UPDATE OR DELETE ON access.target_rating_head
  FOR EACH ROW EXECUTE FUNCTION access.advance_library_rating_version();
