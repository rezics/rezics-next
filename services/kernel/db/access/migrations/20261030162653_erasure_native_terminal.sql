-- migrate:up
-- Native role indexes are typed producer attribution, not shared-copy custody.
CREATE FUNCTION access.erasure_requested_principal(value text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN value ~ '^urn:rezics:request:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    THEN split_part(value, ':', 4)::uuid END;
$$;
ALTER TABLE access.workflow_approval ADD COLUMN erasure_subject_id uuid GENERATED ALWAYS AS ((CASE operation->>'kind' WHEN 'credential' THEN operation->>'subjectAccountId' WHEN 'membership' THEN operation->>'organizationId' WHEN 'opening' THEN operation->>'subjectAccountId' WHEN 'rename' THEN operation->>'accountId' WHEN 'delete' THEN operation->>'accountId' WHEN 'revoke' THEN operation->>'accountId' WHEN 'fence-operator' THEN operation->>'accountId' END)::uuid) STORED;
CREATE INDEX erasure_subject_id_approval ON access.workflow_approval (erasure_subject_id,route,approval_id);
ALTER TABLE access.workflow_approval ADD COLUMN erasure_operator_id uuid GENERATED ALWAYS AS ((CASE WHEN operation->>'kind' IN ('automated','opening','transfer','transfer-acceptance') THEN operation->>'operatorAccountId' END)::uuid) STORED;
CREATE INDEX erasure_operator_id_approval ON access.workflow_approval (erasure_operator_id,route,approval_id);
ALTER TABLE access.workflow_approval ADD COLUMN erasure_member_id uuid GENERATED ALWAYS AS ((CASE WHEN operation->>'kind'='membership' THEN operation->>'memberAccountId' END)::uuid) STORED;
CREATE INDEX erasure_member_id_approval ON access.workflow_approval (erasure_member_id,route,approval_id);
ALTER TABLE access.workflow_approval ADD COLUMN erasure_previous_operator_id uuid GENERATED ALWAYS AS ((CASE WHEN operation->>'kind' IN ('transfer','transfer-acceptance') THEN operation->'previous'->>'operatorAccountId' WHEN operation->>'kind'='delete' THEN operation->'responsibility'->>'operatorAccountId' END)::uuid) STORED;
CREATE INDEX erasure_previous_operator_id_approval ON access.workflow_approval (erasure_previous_operator_id,route,approval_id);
ALTER TABLE access.workflow_approval ADD COLUMN erasure_previous_subject_id uuid GENERATED ALWAYS AS ((CASE WHEN operation->>'kind' IN ('transfer','transfer-acceptance') THEN operation->'previous'->>'subjectAccountId' END)::uuid) STORED;
CREATE INDEX erasure_previous_subject_id_approval ON access.workflow_approval (erasure_previous_subject_id,route,approval_id);
ALTER TABLE access.workflow_approval ADD COLUMN erasure_principal_id uuid GENERATED ALWAYS AS ((access.erasure_requested_principal(requested_by))) STORED;
CREATE INDEX erasure_principal_id_approval ON access.workflow_approval (erasure_principal_id,route,approval_id);
ALTER TABLE access.operator_opening_receipt ADD COLUMN erasure_principal_id uuid
  GENERATED ALWAYS AS (access.erasure_requested_principal(requested_by)) STORED;
CREATE INDEX erasure_opening_principal ON access.operator_opening_receipt (erasure_principal_id,route,operator_account_id,receipt_id);

-- Independent row locators never contain an account, target, cursor or command
-- payload. Historical rows get the same native producer attribution at deployment.
CREATE TABLE access.erasure_continuation_role (
  route integer NOT NULL CHECK(route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  artifact text NOT NULL CHECK(artifact IN ('root','entry','completion','page')),
  row_id uuid NOT NULL,
  PRIMARY KEY(account_id,route,artifact,row_id)
);
CREATE FUNCTION access.erasure_entry_account(step text,target text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE
   WHEN step IN ('erase-auth-owner','revoke-auth-sessions','operator-responsibility-page','operator-unfence-page')
     THEN target::uuid
   WHEN step IN ('retire-operator','release-operator','fence','unfence') THEN split_part(target,':',1)::uuid
 END;
$$;
CREATE FUNCTION access.record_native_continuation_roles() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  root access.committed_continuation;
  artifact text;
  actor uuid;
BEGIN
  artifact := CASE TG_TABLE_NAME WHEN 'committed_continuation' THEN 'root'
    WHEN 'committed_continuation_entry' THEN 'entry'
    WHEN 'committed_continuation_completion' THEN 'completion' ELSE 'page' END;
  SELECT * INTO STRICT root FROM access.committed_continuation
    WHERE route=NEW.route AND continuation_id=NEW.continuation_id;
  INSERT INTO access.erasure_continuation_role(route,account_id,artifact,row_id)
    SELECT NEW.route,id,artifact,NEW.erasure_row_id FROM unnest(ARRAY[root.account_id,root.prior_operator_account_id]) id
    WHERE id IS NOT NULL ON CONFLICT DO NOTHING;
  IF artifact IN ('entry','completion') THEN
    actor := access.erasure_entry_account(NEW.step,NEW.target);
    IF actor IS NOT NULL THEN
      INSERT INTO access.erasure_continuation_role VALUES(NEW.route,actor,artifact,NEW.erasure_row_id) ON CONFLICT DO NOTHING;
    END IF;
  ELSE
    FOR actor IN SELECT access.erasure_entry_account(a->>'step',a->>'target')
      FROM jsonb_array_elements(NEW.allowlist) a LOOP
      IF actor IS NOT NULL THEN
        INSERT INTO access.erasure_continuation_role VALUES(NEW.route,actor,artifact,NEW.erasure_row_id) ON CONFLICT DO NOTHING;
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
ALTER TABLE access.committed_continuation ADD COLUMN erasure_row_id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX committed_continuation_erasure_row ON access.committed_continuation(route,erasure_row_id);
CREATE TRIGGER native_erasure_roles AFTER INSERT ON access.committed_continuation
 FOR EACH ROW EXECUTE FUNCTION access.record_native_continuation_roles();
INSERT INTO access.erasure_continuation_role(route,account_id,artifact,row_id)
 SELECT d.route,a.id,'root',d.erasure_row_id FROM access.committed_continuation d
 JOIN access.committed_continuation c USING(route,continuation_id)
 CROSS JOIN LATERAL unnest(ARRAY[c.account_id,c.prior_operator_account_id]) a(id)
 WHERE a.id IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO access.erasure_continuation_role(route,account_id,artifact,row_id)
 SELECT d.route,access.erasure_entry_account(e->>'step',e->>'target'),'root',d.erasure_row_id FROM access.committed_continuation d CROSS JOIN LATERAL jsonb_array_elements(d.allowlist) e
 WHERE access.erasure_entry_account(e->>'step',e->>'target') IS NOT NULL ON CONFLICT DO NOTHING;
ALTER TABLE access.committed_continuation_entry ADD COLUMN erasure_row_id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX committed_continuation_entry_erasure_row ON access.committed_continuation_entry(route,erasure_row_id);
CREATE TRIGGER native_erasure_roles AFTER INSERT ON access.committed_continuation_entry
 FOR EACH ROW EXECUTE FUNCTION access.record_native_continuation_roles();
INSERT INTO access.erasure_continuation_role(route,account_id,artifact,row_id)
 SELECT d.route,a.id,'entry',d.erasure_row_id FROM access.committed_continuation_entry d
 JOIN access.committed_continuation c USING(route,continuation_id)
 CROSS JOIN LATERAL unnest(ARRAY[c.account_id,c.prior_operator_account_id]) a(id)
 WHERE a.id IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO access.erasure_continuation_role(route,account_id,artifact,row_id)
 SELECT d.route,access.erasure_entry_account(d.step,d.target),'entry',d.erasure_row_id FROM access.committed_continuation_entry d
 WHERE access.erasure_entry_account(d.step,d.target) IS NOT NULL ON CONFLICT DO NOTHING;
ALTER TABLE access.committed_continuation_completion ADD COLUMN erasure_row_id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX committed_continuation_completion_erasure_row ON access.committed_continuation_completion(route,erasure_row_id);
CREATE TRIGGER native_erasure_roles AFTER INSERT ON access.committed_continuation_completion
 FOR EACH ROW EXECUTE FUNCTION access.record_native_continuation_roles();
INSERT INTO access.erasure_continuation_role(route,account_id,artifact,row_id)
 SELECT d.route,a.id,'completion',d.erasure_row_id FROM access.committed_continuation_completion d
 JOIN access.committed_continuation c USING(route,continuation_id)
 CROSS JOIN LATERAL unnest(ARRAY[c.account_id,c.prior_operator_account_id]) a(id)
 WHERE a.id IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO access.erasure_continuation_role(route,account_id,artifact,row_id)
 SELECT d.route,access.erasure_entry_account(d.step,d.target),'completion',d.erasure_row_id FROM access.committed_continuation_completion d
 WHERE access.erasure_entry_account(d.step,d.target) IS NOT NULL ON CONFLICT DO NOTHING;
ALTER TABLE access.operator_fence_page ADD COLUMN erasure_row_id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX operator_fence_page_erasure_row ON access.operator_fence_page(route,erasure_row_id);
CREATE TRIGGER native_erasure_roles AFTER INSERT ON access.operator_fence_page
 FOR EACH ROW EXECUTE FUNCTION access.record_native_continuation_roles();
INSERT INTO access.erasure_continuation_role(route,account_id,artifact,row_id)
 SELECT d.route,a.id,'page',d.erasure_row_id FROM access.operator_fence_page d
 JOIN access.committed_continuation c USING(route,continuation_id)
 CROSS JOIN LATERAL unnest(ARRAY[c.account_id,c.prior_operator_account_id]) a(id)
 WHERE a.id IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO access.erasure_continuation_role(route,account_id,artifact,row_id)
 SELECT d.route,access.erasure_entry_account(e->>'step',e->>'target'),'page',d.erasure_row_id FROM access.operator_fence_page d CROSS JOIN LATERAL jsonb_array_elements(d.allowlist) e
 WHERE access.erasure_entry_account(e->>'step',e->>'target') IS NOT NULL ON CONFLICT DO NOTHING;
CREATE INDEX erasure_continuation_reservation ON access.committed_continuation(route,account_id,prior_reservation_id,prior_operator_account_id);
CREATE INDEX erasure_continuation_barrier ON access.committed_continuation(route,account_id,barrier_receipt_id);

ALTER TABLE access.erasure_native_progress ADD COLUMN native_complete_at timestamptz;
ALTER TABLE access.erasure_native_progress DROP CONSTRAINT erasure_native_progress_pending_check;
ALTER TABLE access.erasure_native_progress ADD CONSTRAINT erasure_native_progress_pending_check
 CHECK(pending IN ('handle-consumer','native-inventory','shared-history-producer'));
ALTER TABLE access.erasure_native_blocked DROP CONSTRAINT erasure_native_blocked_reason_check;
ALTER TABLE access.erasure_native_blocked ADD CONSTRAINT erasure_native_blocked_reason_check CHECK(reason IN (
 'handle-consumer','membership-terminal-consumer','organization-close-consumer','verification-decision-consumer',
 'verification-reversal-consumer','controller-transition-consumer','rating-controller-projection-custody',
 'organization-cursor-cutover','rate-binding-deployment-coverage','auth-fence-release-witness-unavailable',
 'continuation-barrier-consumer','deletion-local-consumer','native-terminal-consumer','approval-consumer-proof-unavailable',
 'opening-consumer-proof-unavailable','credential-consumer-proof-unavailable','continuation-child-consumer',
 'operator-page-consumer','terminal-inventory'));

-- Attribution minimization preserves a surviving applicant's decision and data.
ALTER TABLE access.agent_verification_request ALTER COLUMN requested_by DROP NOT NULL;
ALTER TABLE access.agent_verification_request DROP CONSTRAINT agent_verification_request_check2;

-- Only the terminal native page can erase timestamps. Public readers already
-- exclude deleted identities; immutable identity/floor/fence guards stay enabled.
ALTER TABLE access.account ALTER COLUMN created_at DROP NOT NULL, ALTER COLUMN public_changed_at DROP NOT NULL;
ALTER TABLE access.account ADD CONSTRAINT account_live_timestamps CHECK
 (state='deleted' OR (created_at IS NOT NULL AND public_changed_at IS NOT NULL));
CREATE FUNCTION access.native_terminal_account_ready(value access.account) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT value.state='deleted' AND value.authn_fenced
  AND value.account_id::text=current_setting('rezics.erasure_terminal',true)
  AND EXISTS (SELECT 1 FROM access.erasure e WHERE e.route=value.route AND e.account_id=value.account_id)
  AND EXISTS (SELECT 1 FROM access.erasure_native_progress p WHERE p.route=value.route AND p.account_id=value.account_id
    AND p.progress_id::text=current_setting('rezics.erasure_progress',true)
    -- Durable phases 0..60 precede the terminal account page (61); 62 is
    -- the blocked-page retry scheduler. No earlier page can minimize identity.
    AND p.phase IN (61,62)
    AND NOT EXISTS (SELECT 1 FROM access.erasure_native_blocked b WHERE b.progress_id=p.progress_id AND b.reason<>'terminal-inventory'));
$$;
CREATE OR REPLACE FUNCTION access.guard_account_creation_time() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.created_at IS DISTINCT FROM OLD.created_at AND NOT (NEW.created_at IS NULL AND access.native_terminal_account_ready(OLD)) THEN
  RAISE EXCEPTION 'Account creation time is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION access.advance_operator_relation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF access.native_terminal_account_ready(OLD) AND NEW.operator_relation_version=0
     AND OLD.operator_account_id IS NULL AND NEW.operator_account_id IS NULL
     AND OLD.operator_reservation_id IS NULL AND NEW.operator_reservation_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.operator_account_id IS DISTINCT FROM OLD.operator_account_id
     OR NEW.operator_reservation_id IS DISTINCT FROM OLD.operator_reservation_id THEN
    NEW.operator_relation_version := OLD.operator_relation_version + 1;
  ELSIF NEW.operator_relation_version IS DISTINCT FROM OLD.operator_relation_version THEN
    RAISE EXCEPTION 'Operator relation version is command owned' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION access.record_public_account_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' AND access.native_terminal_account_ready(OLD) THEN
    NEW.public_changed_at := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    NEW.public_changed_at := NEW.created_at;
  ELSIF ROW(NEW.account_id, NEW.kind, NEW.state, NEW.authn_fenced, NEW.avatar, NEW.public_views,
            NEW.speakers_listed, NEW.handle, NEW.display_name, NEW.avatar_url, NEW.biography,
            NEW.links, NEW.operator_account_id, NEW.agent_verified, NEW.agent_subject_id)
        IS DISTINCT FROM
        ROW(OLD.account_id, OLD.kind, OLD.state, OLD.authn_fenced, OLD.avatar, OLD.public_views,
            OLD.speakers_listed, OLD.handle, OLD.display_name, OLD.avatar_url, OLD.biography,
            OLD.links, OLD.operator_account_id, OLD.agent_verified, OLD.agent_subject_id) THEN
    NEW.public_changed_at := statement_timestamp();
  ELSE
    NEW.public_changed_at := OLD.public_changed_at;
  END IF;
  RETURN NEW;
END;
$$;
-- Narrow immutable-row DELETE exception. It validates the permanent native
-- obligation, exact selected row and terminal source in the purge transaction.
CREATE FUNCTION access.native_erasure_delete_ready(store text,value jsonb) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE erased uuid; root access.committed_continuation;
BEGIN
 SELECT p.account_id INTO erased FROM access.erasure_native_progress p JOIN access.erasure e USING(route,account_id)
 WHERE p.progress_id::text=current_setting('rezics.erasure_progress',true);
 IF erased IS NULL OR value->>'erasure_row_id' IS DISTINCT FROM current_setting('rezics.erasure_row',true) THEN RETURN false; END IF;
 IF store='membership_inverse_terminal' THEN
  RETURN (erased=(value->>'account_id')::uuid OR erased=(value->>'group_id')::uuid)
   AND NOT EXISTS (SELECT 1 FROM access.membership_inverse m WHERE m.route=(value->>'route')::int
     AND m.account_id=(value->>'account_id')::uuid AND m.kind=value->>'kind' AND m.group_id=(value->>'group_id')::uuid
     AND m.reservation_id=(value->>'reservation_id')::uuid)
   AND NOT EXISTS (SELECT 1 FROM access.lifecycle_coordination c WHERE c.route=(value->>'route')::int
     AND c.account_id=(value->>'account_id')::uuid AND c.reservation_id=(value->>'reservation_id')::uuid);
 ELSIF store='lifecycle_membership_slot' THEN
  RETURN (value->>'terminal')::boolean AND (erased=(value->>'organization_id')::uuid OR erased=(value->>'member_account_id')::uuid);
 ELSIF store IN ('committed_continuation_entry','committed_continuation_completion','committed_continuation','operator_fence_page') THEN
  IF NOT EXISTS (SELECT 1 FROM access.erasure_continuation_role r WHERE r.route=(value->>'route')::int
    AND r.row_id=(value->>'erasure_row_id')::uuid AND r.account_id=erased
    AND r.artifact=CASE store WHEN 'committed_continuation' THEN 'root' WHEN 'committed_continuation_entry' THEN 'entry'
      WHEN 'committed_continuation_completion' THEN 'completion' ELSE 'page' END) THEN RETURN false; END IF;
  SELECT * INTO root FROM access.committed_continuation WHERE route=(value->>'route')::int
    AND continuation_id=(value->>'continuation_id')::uuid;
  RETURN root.allowlist @> '[{"step":"erase-auth-owner"}]'::jsonb
    AND EXISTS (SELECT 1 FROM access.auth_history_proof p JOIN access.erasure e USING(route,account_id)
      WHERE p.route=root.route AND p.account_id=root.account_id AND p.phase='native-consumed'
        AND p.continuation_id=root.continuation_id AND p.receipt_id=root.barrier_receipt_id AND p.version=e.version AND p.at=e.at)
    AND NOT EXISTS (SELECT 1 FROM access.lifecycle_handle_operation h
      WHERE h.route=root.route AND h.account_id=root.account_id AND h.state='published');
 END IF;
 RETURN false;
END;
$$;
ALTER TABLE access.lifecycle_membership_slot ADD COLUMN erasure_row_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE access.membership_inverse_terminal ADD COLUMN erasure_row_id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE OR REPLACE FUNCTION access.guard_membership_terminal() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' AND access.native_erasure_delete_ready(TG_TABLE_NAME,to_jsonb(OLD)) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Membership terminal proof is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE OR REPLACE FUNCTION access.committed_continuation_completion_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' AND access.native_erasure_delete_ready(TG_TABLE_NAME,to_jsonb(OLD)) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Committed continuation completions are immutable';
END;
$$;
CREATE OR REPLACE FUNCTION access.operator_fence_page_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' AND access.native_erasure_delete_ready(TG_TABLE_NAME,to_jsonb(OLD)) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Operator fence pages are immutable';
END;
$$;
CREATE FUNCTION access.guard_native_continuation_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT access.native_erasure_delete_ready(TG_TABLE_NAME,to_jsonb(OLD))
 OR EXISTS (SELECT 1 FROM access.committed_continuation_entry WHERE route=OLD.route AND continuation_id=OLD.continuation_id)
 OR EXISTS (SELECT 1 FROM access.committed_continuation_completion WHERE route=OLD.route AND continuation_id=OLD.continuation_id)
 OR EXISTS (SELECT 1 FROM access.operator_fence_page WHERE route=OLD.route AND continuation_id=OLD.continuation_id) THEN
  RAISE EXCEPTION 'Continuation erasure requires finished consumers and drained children' USING ERRCODE='23514';
 END IF;
 RETURN OLD;
END;
$$;
CREATE TRIGGER native_continuation_delete BEFORE DELETE ON access.committed_continuation
 FOR EACH ROW EXECUTE FUNCTION access.guard_native_continuation_delete();

-- Opaque original command identity is a permanent replay-refusal skeleton,
-- not a saved allowlist/target or workflow payload.
CREATE TABLE access.erasure_native_consumed_child (
 route integer NOT NULL,
 continuation_id uuid NOT NULL,
 artifact text NOT NULL CHECK(artifact IN ('entry','completion','page')),
 entry_key bytea NOT NULL CHECK(octet_length(entry_key)=32),
 progress_id uuid NOT NULL REFERENCES access.erasure_native_progress(progress_id),
 PRIMARY KEY(route,continuation_id,artifact,entry_key)
);
-- An original child's replay may not repopulate a consumed page. No original
-- caller, bearer, TTL or workflow status supplies fresh authority after purge.
CREATE FUNCTION access.guard_native_erasure_replay() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM access.committed_continuation c
   WHERE c.route=NEW.route AND c.continuation_id=NEW.continuation_id FOR KEY SHARE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Native continuation has been erased' USING ERRCODE='23514';
 END IF;
 IF EXISTS (SELECT 1 FROM access.erasure_native_consumed_child d
   WHERE d.route=NEW.route AND d.continuation_id=NEW.continuation_id
   AND d.artifact=CASE TG_TABLE_NAME WHEN 'committed_continuation_entry' THEN 'entry'
     WHEN 'committed_continuation_completion' THEN 'completion' ELSE 'page' END
   AND d.entry_key=CASE WHEN TG_TABLE_NAME='operator_fence_page'
     THEN sha256(convert_to(to_jsonb(NEW)->>'page_key','UTF8'))
     ELSE sha256(convert_to(concat_ws(':',to_jsonb(NEW)->>'step',to_jsonb(NEW)->>'key'),'UTF8')) END) THEN
  RAISE EXCEPTION 'Native continuation child is permanently consumed' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER native_erasure_replay BEFORE INSERT ON access.committed_continuation_entry FOR EACH ROW EXECUTE FUNCTION access.guard_native_erasure_replay();
CREATE TRIGGER native_erasure_replay BEFORE INSERT ON access.committed_continuation_completion FOR EACH ROW EXECUTE FUNCTION access.guard_native_erasure_replay();
CREATE TRIGGER native_erasure_replay BEFORE INSERT ON access.operator_fence_page FOR EACH ROW EXECUTE FUNCTION access.guard_native_erasure_replay();

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Erased native attribution cannot be restored'; END $$;
