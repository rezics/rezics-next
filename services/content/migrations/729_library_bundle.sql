-- Reader-owned source rows survive unresolved matches and unsupported fields.
ALTER TABLE reader.library_import_batch DROP CONSTRAINT library_import_batch_row_count_check;
ALTER TABLE reader.library_import_batch ADD CONSTRAINT library_import_batch_row_count_check
  CHECK (row_count BETWEEN 1 AND 5000);
CREATE TABLE reader.library_import_file (
  agent text NOT NULL,
  id uuid NOT NULL,
  import_key text NOT NULL,
  format text NOT NULL CHECK (format IN ('goodreads','storygraph','generic-csv','mal','vndb','rezics')),
  file_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '7 days'),
  apply_intent jsonb,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (agent, id),
  UNIQUE (agent, import_key),
  UNIQUE (agent, file_digest),
  FOREIGN KEY (agent, import_key) REFERENCES reader.library_import_batch(agent, import_key)
);
CREATE TABLE reader.library_import_source (
  agent text NOT NULL,
  digest text NOT NULL,
  source jsonb NOT NULL CHECK (jsonb_typeof(source) = 'object'),
  -- Native owner state is exported from its live store. Preserve extension
  -- evidence separately so repeated imports do not duplicate owner snapshots.
  private_extras jsonb GENERATED ALWAYS AS (CASE source->>'kind'
    WHEN 'session' THEN coalesce(source->'raw','{}'::jsonb) - 'nativeSession'
    WHEN 'entry' THEN coalesce(source->'raw','{}'::jsonb) - ARRAY['sessionProjection','shelfId','disclosure','ratingContext','ratingScaleMax','ratingAvailability']
    WHEN 'shelf' THEN coalesce(source->'raw','{}'::jsonb) - ARRAY['shelfId','disclosure']
    ELSE '{}'::jsonb END) STORED,
  PRIMARY KEY (agent,digest)
);
CREATE TABLE reader.library_import_source_row (
  agent text NOT NULL,
  file_id uuid NOT NULL,
  row_number integer NOT NULL CHECK (row_number BETWEEN 0 AND 4999),
  source_digest text NOT NULL,
  match jsonb,
  resolution jsonb,
  outcome jsonb,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (agent, file_id, row_number),
  FOREIGN KEY (agent, file_id) REFERENCES reader.library_import_file(agent, id) ON DELETE CASCADE,
  FOREIGN KEY (agent, source_digest) REFERENCES reader.library_import_source(agent, digest)
);
CREATE TABLE reader.library_import_upload_command (
  agent text NOT NULL,
  idempotency_key text NOT NULL,
  request_digest text NOT NULL,
  file_id uuid,
  PRIMARY KEY (agent,idempotency_key)
);
CREATE TABLE reader.library_import_file_batch (
  agent text NOT NULL,
  file_id uuid NOT NULL,
  import_key text NOT NULL,
  PRIMARY KEY (agent,file_id,import_key),
  FOREIGN KEY (agent,file_id) REFERENCES reader.library_import_file(agent,id) ON DELETE CASCADE
);
-- Receipt identity contains no uploaded fields. It prevents a deleted/expired
-- upload from inventing a new attempt when its source is uploaded again.
CREATE TABLE reader.library_import_session_effect (
  agent text NOT NULL,
  source_identity text NOT NULL,
  session_id text NOT NULL,
  desired_digest text NOT NULL,
  PRIMARY KEY (agent,source_identity)
);
CREATE INDEX library_import_session_lookup ON reader.library_import_session_effect(agent,session_id);
CREATE TABLE reader.library_import_review_command (
  agent text NOT NULL,
  idempotency_key text NOT NULL,
  request_digest text NOT NULL,
  PRIMARY KEY (agent,idempotency_key)
);
CREATE INDEX library_import_pending ON reader.library_import_source_row(agent, file_id, row_number)
  WHERE outcome IS NULL;
CREATE INDEX library_import_source_lookup ON reader.library_import_source_row(agent,source_digest,file_id,row_number);
CREATE INDEX library_import_expiry ON reader.library_import_file(expires_at,agent,id);
CREATE INDEX library_import_export_key ON reader.library_import_source
  (agent, digest)
  WHERE source->>'kind' IN ('source','retained') OR private_extras <> '{}'::jsonb;
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
CREATE TRIGGER library_bundle_source_content AFTER INSERT OR UPDATE OR DELETE ON reader.library_import_source
  FOR EACH ROW EXECUTE FUNCTION reader.advance_library_bundle_fence();
