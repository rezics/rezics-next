-- migrate:up
-- Installation is the only structural cut. Ordinary source commands remain home-local.
CREATE TABLE semantic.identity_epoch_installation_cut (
  partition_no integer PRIMARY KEY CHECK (partition_no=0),
  mode text NOT NULL CHECK (mode IN ('absence','legacy')),
  installation_xid text NOT NULL
);
CREATE TRIGGER identity_epoch_installation_cut_immutable BEFORE UPDATE OR DELETE
  ON semantic.identity_epoch_installation_cut FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER identity_epoch_installation_cut_immutable_truncate BEFORE TRUNCATE
  ON semantic.identity_epoch_installation_cut FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TABLE semantic.identity_epoch_installation (
  partition_no integer PRIMARY KEY CHECK (partition_no=0),
  mode text NOT NULL CHECK (mode IN ('absence','legacy')),
  transaction_id uuid NOT NULL,
  FOREIGN KEY(partition_no) REFERENCES semantic.identity_epoch_installation_cut(partition_no),
  FOREIGN KEY(partition_no,transaction_id)
    REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id)
);
CREATE TRIGGER identity_epoch_installation_immutable BEFORE UPDATE OR DELETE
  ON semantic.identity_epoch_installation FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER identity_epoch_installation_immutable_truncate BEFORE TRUNCATE
  ON semantic.identity_epoch_installation FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();

-- Deferred until the actual creation command has installed its local self custody. No global
-- installation read, guessed epoch, foreign control read or permission decision is made here.
CREATE FUNCTION semantic.guard_identity_epoch_birth() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM semantic.revision r
    JOIN semantic.subject s ON (s.route,s.subject_id)=(r.route,r.subject_id)
    JOIN semantic.identity_epoch_mapping m ON (m.route,m.original)=(r.route,r.subject_id)
    JOIN semantic.identity_epoch_home_gate g ON (g.route,g.destination,g.original)=(r.route,r.subject_id,r.subject_id)
    JOIN core.partition p ON p.partition_no=r.route/16
    WHERE r.route=NEW.route AND r.subject_id=NEW.subject_id AND r.revision=1 AND r.kind='create'
      AND r.xmin::text=pg_current_xact_id()::text AND s.xmin::text=pg_current_xact_id()::text
      AND m.xmin::text=pg_current_xact_id()::text AND g.xmin::text=pg_current_xact_id()::text
      AND r.recorded_transaction_id=NEW.recorded_transaction_id
      AND m.recorded_transaction_id=r.recorded_transaction_id AND g.recorded_transaction_id=r.recorded_transaction_id
      AND m.origin='creation' AND m.terminal=r.subject_id AND m.control_group=r.subject_id
      AND m.control_partition=r.route/16 AND m.owner_epoch=p.epoch AND p.write_state='active'
      AND m.epoch>0 AND g.epoch=m.epoch AND g.terminal=r.subject_id
      AND m.pending_job IS NULL AND g.pending_job IS NULL
  ) THEN RAISE EXCEPTION 'identity_epoch_birth_custody_required'; END IF;
  RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER identity_epoch_birth_custody AFTER INSERT ON semantic.subject
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.guard_identity_epoch_birth();
-- Historical import remains possible before the native installation cut, never after it.
ALTER TABLE semantic.subject DISABLE TRIGGER identity_epoch_birth_custody;

CREATE FUNCTION semantic.identity_epoch_installation_guards() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT count(*)=5 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgenabled='O' AND (
    (t.tgrelid='semantic.subject'::regclass AND t.tgname='identity_epoch_birth_custody'
      AND t.tgfoid='semantic.guard_identity_epoch_birth()'::regprocedure AND t.tgdeferrable AND t.tginitdeferred)
    OR (t.tgfoid='semantic.capture_identity_epoch_source()'::regprocedure AND (
      (t.tgrelid='semantic.subject'::regclass AND t.tgname='identity_epoch_capture_subject') OR
      (t.tgrelid='semantic.account_agent_subject'::regclass AND t.tgname='identity_epoch_capture_backlink') OR
      (t.tgrelid='semantic.redirect'::regclass AND t.tgname='identity_epoch_capture_redirect') OR
      (t.tgrelid='semantic.merge_member'::regclass AND t.tgname='identity_epoch_capture_member')))
  );
$$;

CREATE FUNCTION semantic.read_identity_epoch_installation()
RETURNS TABLE(mode text,transaction_id uuid,epoch integer,"position" bigint,installation_xid text,valid boolean)
LANGUAGE sql STABLE AS $$
  SELECT i.mode,i.transaction_id,c.epoch,c.position,k.installation_xid,
    coalesce(c.purpose='bootstrap' AND p.write_state='active' AND p.epoch=c.epoch AND p.position>=c.position
      AND i.mode=k.mode AND semantic.identity_epoch_installation_guards(),false)
  FROM semantic.identity_epoch_installation i
  JOIN semantic.identity_epoch_installation_cut k USING(partition_no)
  LEFT JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id)=(i.partition_no,i.transaction_id)
  LEFT JOIN core.partition p ON p.partition_no=i.partition_no WHERE i.partition_no=0;
$$;

CREATE FUNCTION semantic.prepare_identity_epoch_installation() RETURNS text LANGUAGE plpgsql AS $$
DECLARE installed record; legacy boolean;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'identity_epoch_installation_requires_read_committed';
  END IF;
  SELECT * INTO installed FROM semantic.identity_epoch_installation_cut WHERE partition_no=0;
  IF FOUND THEN
    IF NOT semantic.identity_epoch_installation_guards() THEN RAISE EXCEPTION 'identity_epoch_installation_unavailable'; END IF;
    RETURN installed.mode;
  END IF;
  -- Drain old writers and exclude concurrent native/legacy installation or source mutations.
  -- Enabling the deferred birth guard and committing the native proof occur under these locks.
  LOCK TABLE semantic.subject,semantic.revision,semantic.redirect,semantic.merge_member,
    semantic.account_agent_subject,semantic.identity_epoch_mapping,semantic.identity_epoch_home_gate,
    semantic.identity_epoch_dirty,semantic.identity_epoch_member_dirty,semantic.identity_epoch_bootstrap_home,
    semantic.identity_epoch_bootstrap_page IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO installed FROM semantic.identity_epoch_installation_cut WHERE partition_no=0;
  IF FOUND THEN
    IF NOT semantic.identity_epoch_installation_guards() THEN RAISE EXCEPTION 'identity_epoch_installation_unavailable'; END IF;
    RETURN installed.mode;
  END IF;
  -- These are complete structural source relations, not a projection/checkpoint or selected homes.
  -- A revision-1 native birth is excluded only with its actual same-transaction self custody.
  SELECT EXISTS (
    SELECT 1 FROM semantic.subject s WHERE NOT EXISTS (
      SELECT 1 FROM semantic.revision r
      JOIN semantic.identity_epoch_mapping m ON (m.route,m.original)=(r.route,r.subject_id)
      JOIN semantic.identity_epoch_home_gate g ON (g.route,g.destination,g.original)=(r.route,r.subject_id,r.subject_id)
      WHERE r.route=s.route AND r.subject_id=s.subject_id AND r.revision=1 AND r.kind='create'
        AND r.recorded_transaction_id=m.recorded_transaction_id AND r.recorded_transaction_id=g.recorded_transaction_id
        AND r.xmin=m.xmin AND r.xmin=g.xmin AND m.origin='creation'
        AND m.terminal=r.subject_id AND m.control_group=r.subject_id AND m.control_partition=r.route/16
        AND m.epoch>0 AND g.epoch=m.epoch AND g.terminal=r.subject_id AND m.pending_job IS NULL AND g.pending_job IS NULL
    )
  ) OR EXISTS (SELECT 1 FROM semantic.revision r WHERE NOT EXISTS (
    SELECT 1 FROM semantic.subject s WHERE (s.route,s.subject_id)=(r.route,r.subject_id)))
    OR EXISTS (SELECT 1 FROM semantic.redirect)
    OR EXISTS (SELECT 1 FROM semantic.merge_member)
    OR EXISTS (SELECT 1 FROM semantic.account_agent_subject a WHERE NOT EXISTS (
      SELECT 1 FROM semantic.subject s WHERE (s.route,s.subject_id)=(a.route,a.subject_id)))
    OR EXISTS (SELECT 1 FROM semantic.identity_epoch_dirty WHERE revision<>captured_revision)
    OR EXISTS (SELECT 1 FROM semantic.identity_epoch_member_dirty)
    OR EXISTS (SELECT 1 FROM semantic.identity_epoch_bootstrap_home)
    OR EXISTS (SELECT 1 FROM semantic.identity_epoch_bootstrap_page)
    INTO legacy;
  ALTER TABLE semantic.subject ENABLE TRIGGER identity_epoch_birth_custody;
  IF NOT semantic.identity_epoch_installation_guards() THEN RAISE EXCEPTION 'identity_epoch_installation_unavailable'; END IF;
  INSERT INTO semantic.identity_epoch_installation_cut VALUES
    (0,CASE WHEN legacy THEN 'legacy' ELSE 'absence' END,pg_current_xact_id()::text);
  RETURN CASE WHEN legacy THEN 'legacy' ELSE 'absence' END;
END; $$;

CREATE FUNCTION semantic.identity_epoch_bootstrap_remaining() RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN i.mode IS NOT NULL AND NOT i.valid THEN 4096
    WHEN i.mode='absence' AND i.valid THEN 0 ELSE t.remaining END
  FROM semantic.identity_epoch_bootstrap_topology t
  LEFT JOIN semantic.read_identity_epoch_installation() i ON true WHERE t.partition_no=0;
$$;

-- migrate:down
DROP FUNCTION semantic.identity_epoch_bootstrap_remaining();
DROP FUNCTION semantic.prepare_identity_epoch_installation();
DROP FUNCTION semantic.read_identity_epoch_installation();
DROP FUNCTION semantic.identity_epoch_installation_guards();
DROP TRIGGER identity_epoch_birth_custody ON semantic.subject;
DROP FUNCTION semantic.guard_identity_epoch_birth();
DROP TABLE semantic.identity_epoch_installation;
DROP TABLE semantic.identity_epoch_installation_cut;
