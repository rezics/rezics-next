CREATE TABLE library.entry_personal_fact (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    fact_id uuid NOT NULL,
    annotation_revision integer DEFAULT 0 NOT NULL,
    note text,
    priority smallint,
    annotation_updated_at timestamp with time zone,
    annotation_transaction_id uuid,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT entry_personal_fact_pkey PRIMARY KEY (route, account_id, subject_id),
    CONSTRAINT entry_personal_fact_fact_id_key UNIQUE (route, account_id, fact_id),
    CONSTRAINT entry_personal_fact_check CHECK (route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11))),
    CONSTRAINT entry_personal_fact_fact_route_check CHECK (route = ((get_byte(uuid_send(fact_id), 10) * 256) + get_byte(uuid_send(fact_id), 11))),
    CONSTRAINT entry_personal_fact_route_check CHECK (route >= 0 AND route <= 65535),
    CONSTRAINT entry_personal_fact_revision_check CHECK (annotation_revision >= 0 AND annotation_revision <= 2147483646),
    CONSTRAINT entry_personal_fact_note_check CHECK (note IS NULL OR (octet_length(note) BETWEEN 1 AND 4096)),
    CONSTRAINT entry_personal_fact_priority_check CHECK (priority IS NULL OR priority BETWEEN 1 AND 100),
    CONSTRAINT entry_personal_fact_annotation_audit_check CHECK (
      (annotation_revision = 0 AND note IS NULL AND priority IS NULL AND annotation_updated_at IS NULL AND annotation_transaction_id IS NULL)
      OR (annotation_revision > 0 AND annotation_updated_at IS NOT NULL AND annotation_transaction_id IS NOT NULL)
    )
);

CREATE TABLE library.entry_source_observation (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    provider text COLLATE pg_catalog."C" NOT NULL,
    record_id text COLLATE pg_catalog."C" NOT NULL,
    revision integer NOT NULL,
    privacy_status text NOT NULL,
    privacy_meaning text,
    privacy_source_value text,
    source_created_status text NOT NULL,
    source_created_value text,
    source_created_precision text,
    source_created_zone text,
    source_updated_status text NOT NULL,
    source_updated_value text,
    source_updated_precision text,
    source_updated_zone text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT entry_source_observation_pkey PRIMARY KEY (route, account_id, subject_id, provider, record_id),
    CONSTRAINT entry_source_observation_parent_fkey FOREIGN KEY (route, account_id, subject_id)
      REFERENCES library.entry_personal_fact(route, account_id, subject_id) ON DELETE CASCADE,
    CONSTRAINT entry_source_observation_check CHECK (route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11))),
    CONSTRAINT entry_source_observation_route_check CHECK (route >= 0 AND route <= 65535),
    CONSTRAINT entry_source_observation_revision_check CHECK (revision >= 1 AND revision <= 2147483646),
    CONSTRAINT entry_source_observation_provider_check CHECK (octet_length(provider) BETWEEN 1 AND 64),
    CONSTRAINT entry_source_observation_record_id_check CHECK (octet_length(record_id) BETWEEN 1 AND 192),
    CONSTRAINT entry_source_observation_privacy_check CHECK (
      (privacy_status = 'known' AND privacy_meaning IS NOT NULL AND privacy_meaning IN ('private', 'source_visible')
        AND privacy_source_value IS NULL)
      OR (privacy_status = 'unknown' AND privacy_meaning IS NULL
        AND (privacy_source_value IS NULL OR octet_length(privacy_source_value) BETWEEN 1 AND 192))
      OR (privacy_status IN ('absent', 'cleared') AND privacy_meaning IS NULL AND privacy_source_value IS NULL)
    ),
    CONSTRAINT entry_source_observation_created_check CHECK (
      (source_created_status = 'known' AND source_created_value IS NOT NULL AND octet_length(source_created_value) BETWEEN 4 AND 64
        AND source_created_precision IS NOT NULL AND source_created_precision IN ('year', 'month', 'day', 'minute', 'second', 'fraction')
        AND source_created_zone IS NOT NULL AND source_created_zone IN ('utc', 'offset', 'unknown'))
      OR (source_created_status = 'unknown' AND (source_created_value IS NULL OR octet_length(source_created_value) BETWEEN 1 AND 64)
        AND source_created_precision IS NULL AND source_created_zone IS NULL)
      OR (source_created_status IN ('absent', 'cleared') AND source_created_value IS NULL
        AND source_created_precision IS NULL AND source_created_zone IS NULL)
    ),
    CONSTRAINT entry_source_observation_updated_check CHECK (
      (source_updated_status = 'known' AND source_updated_value IS NOT NULL AND octet_length(source_updated_value) BETWEEN 4 AND 64
        AND source_updated_precision IS NOT NULL AND source_updated_precision IN ('year', 'month', 'day', 'minute', 'second', 'fraction')
        AND source_updated_zone IS NOT NULL AND source_updated_zone IN ('utc', 'offset', 'unknown'))
      OR (source_updated_status = 'unknown' AND (source_updated_value IS NULL OR octet_length(source_updated_value) BETWEEN 1 AND 64)
        AND source_updated_precision IS NULL AND source_updated_zone IS NULL)
      OR (source_updated_status IN ('absent', 'cleared') AND source_updated_value IS NULL
        AND source_updated_precision IS NULL AND source_updated_zone IS NULL)
    )
);

CREATE OR REPLACE FUNCTION library.maintain_owner_member_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE f text; p jsonb;
BEGIN
  f := CASE TG_TABLE_NAME WHEN 'entry' THEN 'entry' WHEN 'entry_personal_fact' THEN 'entry'
    WHEN 'entry_source_observation' THEN 'entry' WHEN 'progress_session' THEN 'session'
    WHEN 'copy' THEN 'copy' WHEN 'label_assignment' THEN 'label' END;
  IF TG_OP <> 'INSERT' THEN
    p := CASE WHEN f='label' THEN '{}'::jsonb ELSE COALESCE(to_jsonb(OLD)->'library_profile_pin','{}'::jsonb) END;
    IF p='null'::jsonb THEN p:='{}'::jsonb; END IF;
    PERFORM library.refresh_owner_member_scope(OLD.route,OLD.account_id,OLD.subject_id,f,p);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    p := CASE WHEN f='label' THEN '{}'::jsonb ELSE COALESCE(to_jsonb(NEW)->'library_profile_pin','{}'::jsonb) END;
    IF p='null'::jsonb THEN p:='{}'::jsonb; END IF;
    PERFORM library.refresh_owner_member_scope(NEW.route,NEW.account_id,NEW.subject_id,f,p);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION library.refresh_owner_member_scope(r integer, a uuid, s uuid, f text, p jsonb) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE live boolean;
BEGIN
  PERFORM 1 FROM library.fact_source_head WHERE route=r AND account_id=a FOR UPDATE;
  IF f='entry' THEN
    SELECT EXISTS (SELECT 1 FROM library.entry WHERE route=r AND account_id=a AND subject_id=s
      AND COALESCE(library_profile_pin,'{}'::jsonb)=p) OR
      (p='{}'::jsonb AND EXISTS (SELECT 1 FROM library.entry_personal_fact x WHERE x.route=r AND x.account_id=a
        AND x.subject_id=s AND (x.note IS NOT NULL OR x.priority IS NOT NULL OR EXISTS (
          SELECT 1 FROM library.entry_source_observation o WHERE o.route=x.route AND o.account_id=x.account_id
            AND o.subject_id=x.subject_id)))) INTO live;
  ELSIF f='session' THEN
    SELECT EXISTS (SELECT 1 FROM library.progress_session WHERE route=r AND account_id=a AND subject_id=s
      AND COALESCE(library_profile_pin,'{}'::jsonb)=p) INTO live;
  ELSIF f='copy' THEN
    SELECT EXISTS (SELECT 1 FROM library.copy WHERE route=r AND account_id=a AND subject_id=s
      AND deletion_id IS NULL AND COALESCE(library_profile_pin,'{}'::jsonb)=p) INTO live;
  ELSIF f='label' THEN
    SELECT EXISTS (SELECT 1 FROM library.label_assignment x WHERE x.route=r AND x.account_id=a AND x.subject_id=s
      AND x.deleted_at IS NULL AND (x.slot_no IS NULL OR x.assignment_id IS NULL)) OR
    EXISTS (SELECT 1 FROM library.label_assignment x WHERE x.route=r AND x.account_id=a AND x.subject_id=s
      AND x.deleted_at IS NULL AND x.slot_no IS NOT NULL AND x.assignment_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM library.personal_label l WHERE l.route=r AND l.account_id=a AND l.label_id=x.label_id
          AND l.deleted_at IS NULL)) INTO live;
  ELSE RAISE EXCEPTION 'Unknown owner member family'; END IF;
  IF live THEN
    INSERT INTO library.owner_member_support VALUES(r,a,s,f,p) ON CONFLICT DO NOTHING;
    INSERT INTO library.owner_member_index VALUES(r,a,s) ON CONFLICT DO NOTHING;
    INSERT INTO library.owner_index_pin(route,account_id,pin) VALUES(r,a,p) ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM library.owner_member_support WHERE route=r AND account_id=a AND subject_id=s AND family=f AND pin=p;
    DELETE FROM library.owner_index_pin WHERE route=r AND account_id=a AND pin=p AND NOT EXISTS (
      SELECT 1 FROM library.owner_member_support WHERE route=r AND account_id=a AND pin=p);
    DELETE FROM library.owner_member_index WHERE route=r AND account_id=a AND subject_id=s AND NOT EXISTS (
      SELECT 1 FROM library.owner_member_support WHERE route=r AND account_id=a AND subject_id=s);
  END IF;
END;
$$;

CREATE TRIGGER entry_personal_fact_source_rows AFTER INSERT OR DELETE ON library.entry_personal_fact
  FOR EACH ROW EXECUTE FUNCTION library.advance_fact_source_head();
CREATE TRIGGER entry_personal_fact_source_update AFTER UPDATE ON library.entry_personal_fact
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION library.advance_fact_source_head();
CREATE TRIGGER entry_personal_fact_native_writer AFTER INSERT OR DELETE OR UPDATE ON library.entry_personal_fact
  FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();
CREATE TRIGGER zz_entry_personal_fact_owner_scope_rows AFTER INSERT OR DELETE ON library.entry_personal_fact
  FOR EACH ROW EXECUTE FUNCTION library.maintain_owner_member_scope();
CREATE TRIGGER zz_entry_personal_fact_owner_scope_update AFTER UPDATE ON library.entry_personal_fact
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION library.maintain_owner_member_scope();

CREATE TRIGGER entry_source_observation_source_rows AFTER INSERT OR DELETE ON library.entry_source_observation
  FOR EACH ROW EXECUTE FUNCTION library.advance_fact_source_head();
CREATE TRIGGER entry_source_observation_source_update AFTER UPDATE ON library.entry_source_observation
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION library.advance_fact_source_head();
CREATE TRIGGER entry_source_observation_native_writer AFTER INSERT OR DELETE OR UPDATE ON library.entry_source_observation
  FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();
CREATE TRIGGER zz_entry_source_observation_owner_scope_rows AFTER INSERT OR DELETE ON library.entry_source_observation
  FOR EACH ROW EXECUTE FUNCTION library.maintain_owner_member_scope();
CREATE TRIGGER zz_entry_source_observation_owner_scope_update AFTER UPDATE ON library.entry_source_observation
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION library.maintain_owner_member_scope();

CREATE INDEX entry_source_observation_owner ON library.entry_source_observation USING btree
  (route, account_id, subject_id, provider COLLATE pg_catalog."C", record_id COLLATE pg_catalog."C");
