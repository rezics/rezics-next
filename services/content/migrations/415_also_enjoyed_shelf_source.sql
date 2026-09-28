-- The Work-leading seek is for rebuilding public co-reader signals. Visibility
-- remains in Access; this index alone never makes a shelf public.
CREATE INDEX library_status_also_enjoyed_work ON reader.library_status (work, agent)
  WHERE status IN ('read', 'reading');

-- A transactional revision fences a multi-batch generation against changes to
-- Content's source rows, including clear and truncate operations.
CREATE TABLE reader.also_enjoyed_source_fence (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
INSERT INTO reader.also_enjoyed_source_fence DEFAULT VALUES;
CREATE FUNCTION reader.advance_also_enjoyed_source_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NULL; END IF;
  UPDATE reader.also_enjoyed_source_fence SET revision = revision + 1 WHERE id;
  RETURN NULL;
END $$;
CREATE TRIGGER also_enjoyed_status_changed AFTER INSERT OR UPDATE OR DELETE
  ON reader.library_status FOR EACH ROW EXECUTE FUNCTION reader.advance_also_enjoyed_source_fence();
CREATE TRIGGER also_enjoyed_status_truncated AFTER TRUNCATE
  ON reader.library_status FOR EACH STATEMENT EXECUTE FUNCTION reader.advance_also_enjoyed_source_fence();
