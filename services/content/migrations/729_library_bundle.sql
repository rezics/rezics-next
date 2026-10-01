-- Reader-owned source rows survive unresolved matches and unsupported fields.
ALTER TABLE reader.library_import_batch DROP CONSTRAINT library_import_batch_row_count_check;
ALTER TABLE reader.library_import_batch ADD CONSTRAINT library_import_batch_row_count_check
  CHECK (row_count BETWEEN 1 AND 5000);
CREATE TABLE reader.library_import_file (
  agent text NOT NULL,
  id uuid NOT NULL,
  import_key text NOT NULL,
  format text NOT NULL CHECK (format IN ('goodreads','storygraph','generic-csv','mal','vndb','rezics')),
  apply_intent jsonb,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (agent, id),
  UNIQUE (agent, import_key),
  FOREIGN KEY (agent, import_key) REFERENCES reader.library_import_batch(agent, import_key)
);
CREATE TABLE reader.library_import_source_row (
  agent text NOT NULL,
  file_id uuid NOT NULL,
  row_number integer NOT NULL CHECK (row_number BETWEEN 0 AND 4999),
  source jsonb NOT NULL CHECK (jsonb_typeof(source) = 'object'),
  match jsonb,
  resolution jsonb,
  outcome jsonb,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (agent, file_id, row_number),
  FOREIGN KEY (agent, file_id) REFERENCES reader.library_import_file(agent, id)
);
CREATE TABLE reader.library_import_review_command (
  agent text NOT NULL,
  idempotency_key text NOT NULL,
  request_digest text NOT NULL,
  PRIMARY KEY (agent,idempotency_key)
);
CREATE INDEX library_import_pending ON reader.library_import_source_row(agent, file_id, row_number)
  WHERE outcome IS NULL;
CREATE INDEX library_import_export_key ON reader.library_import_source_row
  (agent, (file_id::text || ':' || lpad(row_number::text,4,'0')))
  WHERE source->>'kind' IN ('source','retained');
CREATE TABLE reader.library_bundle_fence (
  agent text PRIMARY KEY,
  version bigint NOT NULL DEFAULT 0
);
CREATE FUNCTION reader.advance_library_bundle_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO reader.library_bundle_fence(agent, version) VALUES (COALESCE(NEW.agent,OLD.agent), 1)
  ON CONFLICT (agent) DO UPDATE SET version = reader.library_bundle_fence.version + 1;
  RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER library_bundle_status AFTER INSERT OR UPDATE OR DELETE ON reader.library_status
  FOR EACH ROW EXECUTE FUNCTION reader.advance_library_bundle_fence();
CREATE TRIGGER library_bundle_reviews AFTER INSERT OR UPDATE OR DELETE ON reader.private_import_review
  FOR EACH ROW EXECUTE FUNCTION reader.advance_library_bundle_fence();
CREATE TRIGGER library_bundle_sessions AFTER INSERT OR UPDATE OR DELETE ON reader.consumption_session
  FOR EACH ROW EXECUTE FUNCTION reader.advance_library_bundle_fence();
CREATE TRIGGER library_bundle_sources AFTER INSERT OR UPDATE OR DELETE ON reader.library_import_source_row
  FOR EACH ROW EXECUTE FUNCTION reader.advance_library_bundle_fence();
