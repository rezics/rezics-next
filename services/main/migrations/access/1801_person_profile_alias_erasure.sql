-- Permanent opaque reservations stay in the alias owner after raw names clear.
CREATE FUNCTION access.alias_digest(value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT encode(sha256(convert_to(value, 'UTF8')), 'hex')
$$;

ALTER TABLE access.alias_registry ADD COLUMN key_digest text,
  ADD COLUMN skeleton_digest text, ADD COLUMN profile_erasure_id uuid,
  ADD COLUMN profile_erasure_epoch bigint;
ALTER TABLE access.alias_history ADD COLUMN key_digest text,
  ADD COLUMN profile_erasure_id uuid, ADD COLUMN profile_erasure_epoch bigint;
ALTER TABLE access.alias_receipt ADD COLUMN profile_erasure_id uuid,
  ADD COLUMN profile_erasure_epoch bigint;
ALTER TABLE access.alias_graph_import_report ADD COLUMN source_digest text,
  ADD COLUMN holder text, ADD COLUMN profile_erasure_id uuid,
  ADD COLUMN profile_erasure_epoch bigint;

-- Replace the old raw-key guards together with their identity constraints in
-- this migration transaction; runtime erasure never switches guards off.
DROP TRIGGER retain_alias_holder ON access.alias_registry;
DROP TRIGGER immutable_alias_history ON access.alias_history;
UPDATE access.alias_registry SET key_digest = access.alias_digest(key),
  skeleton_digest = access.alias_digest(skeleton);
UPDATE access.alias_history SET key_digest = access.alias_digest(key);
UPDATE access.alias_graph_import_report SET source_digest = access.alias_digest(source),
  holder = CASE
    WHEN legacy_alias->'holder'->>'value' ~ '^https://rezics.com/id/[0-9a-f-]{36}$'
      THEN legacy_alias->'holder'->>'value'
    WHEN split_part(source, '#', 1) ~ '^https://rezics.com/id/[0-9a-f-]{36}$'
      THEN split_part(source, '#', 1)
  END;

ALTER TABLE access.alias_history DROP CONSTRAINT alias_history_scope_key_fkey;
ALTER TABLE access.alias_registry DROP CONSTRAINT alias_registry_pkey,
  ALTER COLUMN key DROP NOT NULL, ALTER COLUMN skeleton DROP NOT NULL,
  ALTER COLUMN key_digest SET NOT NULL, ALTER COLUMN skeleton_digest SET NOT NULL,
  ADD PRIMARY KEY(scope,key_digest),
  ADD CHECK (key_digest ~ '^[0-9a-f]{64}$' AND skeleton_digest ~ '^[0-9a-f]{64}$'),
  ADD CHECK ((profile_erasure_id IS NULL AND profile_erasure_epoch IS NULL
    AND key IS NOT NULL AND skeleton IS NOT NULL)
    OR (profile_erasure_id IS NOT NULL AND profile_erasure_epoch IS NOT NULL AND profile_erasure_epoch > 0
      AND scope = 'agent' AND key IS NULL AND skeleton IS NULL AND state = 'retired'
      AND successor IS NULL));
ALTER TABLE access.alias_history ALTER COLUMN key DROP NOT NULL,
  ALTER COLUMN key_digest SET NOT NULL,
  ADD FOREIGN KEY(scope,key_digest) REFERENCES access.alias_registry(scope,key_digest),
  ADD CHECK ((profile_erasure_id IS NULL AND profile_erasure_epoch IS NULL AND key IS NOT NULL)
    OR (profile_erasure_id IS NOT NULL AND profile_erasure_epoch IS NOT NULL AND profile_erasure_epoch > 0 AND scope = 'agent'
      AND key IS NULL AND successor IS NULL));
ALTER TABLE access.alias_graph_import_report DROP CONSTRAINT alias_graph_import_report_pkey,
  ALTER COLUMN source DROP NOT NULL, ALTER COLUMN source_digest SET NOT NULL,
  ADD PRIMARY KEY(data_epoch,source_digest),
  ADD CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  ADD CHECK ((profile_erasure_id IS NULL AND profile_erasure_epoch IS NULL AND source IS NOT NULL)
    OR (profile_erasure_id IS NOT NULL AND profile_erasure_epoch IS NOT NULL AND profile_erasure_epoch > 0 AND holder IS NOT NULL
      AND source IS NULL AND legacy_alias IS NULL AND reason = 'Person alias erased'));
ALTER TABLE access.alias_receipt ADD CHECK
  ((profile_erasure_id IS NULL AND profile_erasure_epoch IS NULL)
    OR (profile_erasure_id IS NOT NULL AND profile_erasure_epoch IS NOT NULL AND profile_erasure_epoch > 0
      AND result->>'profile' IS NOT DISTINCT FROM 'alias-erased-v1' AND result->>'scope' IS NOT DISTINCT FROM 'agent'
      AND NOT result ?| ARRAY['key','previousKey','display','successor']));

CREATE INDEX alias_registry_digest_skeleton ON access.alias_registry(scope,skeleton_digest,holder,controller);
CREATE UNIQUE INDEX alias_registry_raw_key ON access.alias_registry(scope,key) WHERE key IS NOT NULL;
CREATE INDEX alias_registry_digest_handle_skeleton ON access.alias_registry(skeleton_digest,controller,holder)
  WHERE scope IN ('agent','space');
CREATE INDEX alias_registry_person_erasure ON access.alias_registry(holder,key_digest) WHERE scope = 'agent';
CREATE INDEX alias_history_person_erasure ON access.alias_history(holder,revision) WHERE scope = 'agent';
CREATE INDEX alias_receipt_person_erasure ON access.alias_receipt((result->>'holder'),principal_id,idempotency_key)
  WHERE result->>'scope' = 'agent';
CREATE INDEX alias_import_person_erasure ON access.alias_graph_import_report(holder,data_epoch,source_digest);

-- Terminal evidence already belongs to these owners. Keep a stale import from
-- recreating a raw copy between alias sanitation and provision sanitation.
CREATE FUNCTION access.alias_person_erased(person text) RETURNS boolean LANGUAGE sql AS $$
  SELECT EXISTS (SELECT 1 FROM access.agent_provision WHERE agent_id = person AND profile_erasure_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM access.alias_registry WHERE scope = 'agent' AND holder = person AND profile_erasure_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM access.alias_history WHERE scope = 'agent' AND holder = person AND profile_erasure_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM access.alias_receipt WHERE result->>'scope' = 'agent' AND result->>'holder' = person
      AND profile_erasure_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM access.alias_graph_import_report WHERE holder = person AND profile_erasure_id IS NOT NULL)
$$;

CREATE OR REPLACE VIEW access.agent_handle AS
  SELECT key AS handle,holder AS agent_id,
    CASE WHEN state = 'current' THEN 'current' ELSE 'retired' END AS state,
    claimed_at,CASE WHEN state = 'current' THEN NULL ELSE 'infinity'::timestamptz END AS retired_until,
    skeleton FROM access.alias_registry WHERE scope = 'agent' AND profile_erasure_id IS NULL
  UNION ALL
  SELECT NULL::text,NULL::text,NULL::text,NULL::timestamptz,NULL::timestamptz,NULL::text WHERE false;

-- One authority owner qualifies every narrow exception. This function only
-- checks sanitation shape and the proof stamps; Access decides authorization.
CREATE FUNCTION access.assert_alias_person_erasure(person text, erasure uuid, epoch bigint)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE proof jsonb := NULLIF(current_setting('rezics.person_profile_erasure', true),'')::jsonb;
BEGIN
  PERFORM access.assert_person_profile_erasure(person);
  IF erasure IS DISTINCT FROM (proof->>'erasureId')::uuid
    OR epoch IS DISTINCT FROM (proof->>'erasureEpoch')::bigint THEN
    RAISE EXCEPTION 'Alias erasure proof changed' USING ERRCODE = '23514';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION access.retain_alias_holder() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Alias ownership is permanent' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.scope = 'agent' THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('alias-holder:agent:' || NEW.holder,0));
    END IF;
    IF NEW.profile_erasure_id IS NOT NULL OR access.alias_person_erased(NEW.holder) THEN
      RAISE EXCEPTION 'Erased Person alias cannot be replanted' USING ERRCODE = '23514';
    END IF;
    NEW.key_digest := access.alias_digest(NEW.key);
    NEW.skeleton_digest := access.alias_digest(NEW.skeleton);
    RETURN NEW;
  END IF;
  IF OLD.profile_erasure_id IS NOT NULL THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Erased alias reservation is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.profile_erasure_id IS NOT NULL THEN
    PERFORM access.assert_alias_person_erasure(OLD.holder,NEW.profile_erasure_id,NEW.profile_erasure_epoch);
    IF OLD.scope <> 'agent' OR NEW.key IS NOT NULL OR NEW.skeleton IS NOT NULL
      OR NEW.state <> 'retired' OR NEW.successor IS NOT NULL
      OR (to_jsonb(NEW) - ARRAY['key','skeleton','state','successor','profile_erasure_id','profile_erasure_epoch'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['key','skeleton','state','successor','profile_erasure_id','profile_erasure_epoch']) THEN
      RAISE EXCEPTION 'Invalid alias sanitation' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.scope IS DISTINCT FROM OLD.scope OR NEW.key IS DISTINCT FROM OLD.key
    OR NEW.key_digest IS DISTINCT FROM OLD.key_digest
    OR NEW.skeleton IS DISTINCT FROM OLD.skeleton OR NEW.skeleton_digest IS DISTINCT FROM OLD.skeleton_digest
    OR NEW.profile_erasure_epoch IS NOT NULL THEN
    RAISE EXCEPTION 'Alias ownership is permanent' USING ERRCODE = '23514';
  END IF;
  IF NEW.holder <> OLD.holder AND NOT (OLD.scope = 'space' AND OLD.state = 'retired'
    AND NEW.controller = OLD.controller AND EXISTS (SELECT 1 FROM access.admission a
      WHERE a.id = OLD.creation_admission AND a.action = 'space.create' AND a.acting_subject = OLD.controller
        AND a.state = 'sealed' AND a.graph_outcome = 'cancelled')) THEN
    RAISE EXCEPTION 'Alias ownership is permanent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER retain_alias_holder BEFORE INSERT OR UPDATE OR DELETE ON access.alias_registry
  FOR EACH ROW EXECUTE FUNCTION access.retain_alias_holder();

CREATE OR REPLACE FUNCTION access.reject_alias_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.scope = 'agent' THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('alias-holder:agent:' || NEW.holder,0));
    END IF;
    IF NEW.profile_erasure_id IS NOT NULL OR access.alias_person_erased(NEW.holder) THEN
      RAISE EXCEPTION 'Erased Person alias history cannot be replanted' USING ERRCODE = '23514';
    END IF;
    NEW.key_digest := access.alias_digest(NEW.key);
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.profile_erasure_id IS NULL AND NEW.profile_erasure_id IS NOT NULL THEN
    PERFORM access.assert_alias_person_erasure(OLD.holder,NEW.profile_erasure_id,NEW.profile_erasure_epoch);
    IF OLD.scope = 'agent' AND NEW.key IS NULL AND NEW.successor IS NULL
      AND (to_jsonb(NEW) - ARRAY['key','successor','profile_erasure_id','profile_erasure_epoch'])
        IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['key','successor','profile_erasure_id','profile_erasure_epoch']) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'Alias history is immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER immutable_alias_history BEFORE INSERT OR UPDATE OR DELETE ON access.alias_history
  FOR EACH ROW EXECUTE FUNCTION access.reject_alias_history_change();

CREATE FUNCTION access.guard_alias_person_copies() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE person text; raw_person text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.profile_erasure_id IS NOT NULL THEN
      RAISE EXCEPTION 'Alias erasure evidence is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_TABLE_NAME = 'alias_receipt' THEN
    person := NEW.result->>'holder';
  ELSE
    raw_person := CASE
      WHEN NEW.legacy_alias->'holder'->>'value' ~ '^https://rezics.com/id/[0-9a-f-]{36}$'
        THEN NEW.legacy_alias->'holder'->>'value'
      WHEN split_part(NEW.source, '#', 1) ~ '^https://rezics.com/id/[0-9a-f-]{36}$'
        THEN split_part(NEW.source, '#', 1) END;
    IF TG_OP = 'INSERT' THEN
      NEW.source_digest := access.alias_digest(NEW.source);
      NEW.holder := raw_person;
    ELSE
      IF NEW.source_digest IS DISTINCT FROM OLD.source_digest THEN
        RAISE EXCEPTION 'Import identity is immutable' USING ERRCODE = '23514';
      END IF;
      NEW.holder := COALESCE(OLD.holder,raw_person);
      IF NEW.profile_erasure_id IS NULL AND (NEW.source_digest IS DISTINCT FROM access.alias_digest(NEW.source)
        OR (raw_person IS NOT NULL AND NEW.holder IS DISTINCT FROM raw_person)) THEN
        RAISE EXCEPTION 'Import retained holder changed' USING ERRCODE = '23514';
      END IF;
    END IF;
    person := NEW.holder;
  END IF;
  IF person IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('alias-holder:agent:' || person,0));
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.profile_erasure_id IS NOT NULL THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Alias erasure evidence is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.profile_erasure_id IS NOT NULL THEN
    IF TG_OP <> 'UPDATE' THEN
      RAISE EXCEPTION 'Alias sanitation requires retained evidence' USING ERRCODE = '23514';
    END IF;
    PERFORM access.assert_alias_person_erasure(person,NEW.profile_erasure_id,NEW.profile_erasure_epoch);
    IF TG_TABLE_NAME = 'alias_receipt' THEN
      IF OLD.result->>'scope' IS DISTINCT FROM 'agent' OR NEW.result IS DISTINCT FROM
        ((OLD.result - ARRAY['key','previousKey','display','successor']) || '{"profile":"alias-erased-v1"}'::jsonb)
        OR (to_jsonb(NEW) - ARRAY['result','profile_erasure_id','profile_erasure_epoch']) IS DISTINCT FROM
          (to_jsonb(OLD) - ARRAY['result','profile_erasure_id','profile_erasure_epoch']) THEN
        RAISE EXCEPTION 'Invalid alias receipt sanitation' USING ERRCODE = '23514';
      END IF;
    ELSE
      IF NEW.source IS NOT NULL OR NEW.legacy_alias IS NOT NULL OR NEW.reason <> 'Person alias erased'
        OR (to_jsonb(NEW) - ARRAY['source','legacy_alias','reason','profile_erasure_id','profile_erasure_epoch']) IS DISTINCT FROM
          (to_jsonb(OLD) - ARRAY['source','legacy_alias','reason','profile_erasure_id','profile_erasure_epoch']) THEN
        RAISE EXCEPTION 'Invalid alias import sanitation' USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF NEW.profile_erasure_epoch IS NOT NULL OR access.alias_person_erased(person) THEN
    RAISE EXCEPTION 'Erased Person alias copy cannot be replanted' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_alias_person_receipts BEFORE INSERT OR UPDATE OR DELETE ON access.alias_receipt
  FOR EACH ROW EXECUTE FUNCTION access.guard_alias_person_copies();
CREATE TRIGGER guard_alias_person_imports BEFORE INSERT OR UPDATE OR DELETE ON access.alias_graph_import_report
  FOR EACH ROW EXECUTE FUNCTION access.guard_alias_person_copies();
