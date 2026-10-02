-- One permanent name inventory. Slugs are derived and are never persisted here.
CREATE TABLE access.name_reserved_word (
  word text PRIMARY KEY,
  handles boolean NOT NULL DEFAULT true,
  titles boolean NOT NULL DEFAULT false
);
INSERT INTO access.name_reserved_word(word) SELECT unnest(ARRAY['a','about','abuse','account','accounts','admin','administrator','admins','agent','agents','api','auth','authors','billing','catalogue','concepts','contact','create','discover','e','groups','handles','health','help','home','identity','inbox','isbn','library','locale','login','manage','me','mod','moderator','moderators','mods','new','notifications','official','onboarding','owner','postmaster','profile','proposals','r','realms','recovery','register','release','releases','report','rezics','root','safety','search','security','settings','shelves','sign-in','sign-out','sign_in','sign_out','signup','spaces','staff','studio','submit','support','system','team','trust','user','users','v1','w','webmaster','welcome','works','z','zones']);
UPDATE access.name_reserved_word SET titles = true WHERE word IN ('new','create');

-- Same frozen alphabet and 128-bit bound as @rezics/model/address/sid.
CREATE FUNCTION access.is_address_sid(value text) RETURNS boolean
 LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE alphabet constant text := '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
 total numeric := 0; digit integer; position integer;
BEGIN
 IF length(value) <> 22 THEN RETURN false; END IF;
 FOR position IN 1..22 LOOP
   digit := strpos(alphabet,substr(value,position,1)) - 1;
   IF digit < 0 THEN RETURN false; END IF;
   total := total * 58 + digit;
 END LOOP;
 RETURN total < 340282366920938463463374607431768211456;
END $$;

-- Minimum over all ASCII case variants, matching hasSidCaseVariant.
CREATE FUNCTION access.has_address_sid_case_variant(value text) RETURNS boolean
 LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE alphabet constant text := '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
 total numeric := 0; a integer; b integer; digit integer; position integer;
BEGIN
 IF length(value) <> 22 THEN RETURN false; END IF;
 FOR position IN 1..22 LOOP
   a := strpos(alphabet,upper(substr(value,position,1))) - 1;
   b := strpos(alphabet,lower(substr(value,position,1))) - 1;
   IF a < 0 AND b < 0 THEN RETURN false; END IF;
   digit := CASE WHEN a < 0 THEN b WHEN b < 0 THEN a ELSE LEAST(a,b) END;
   total := total * 58 + digit;
 END LOOP;
 RETURN total < 340282366920938463463374607431768211456;
END $$;

CREATE TABLE access.name_registry (
  scope text NOT NULL CHECK (scope IN ('agent','space','work') OR scope ~ '^zone:https://rezics.com/id/[0-9a-f-]{36}$'),
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 512),
  display text NOT NULL,
  skeleton text NOT NULL,
  holder text NOT NULL CHECK (holder ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  controller text NOT NULL,
  state text NOT NULL CHECK (state IN ('current','redirect','retired')),
  revision uuid NOT NULL DEFAULT gen_random_uuid(),
  successor text CHECK (successor ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  creation_admission uuid REFERENCES access.admission(id),
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope,key),
  CHECK (creation_admission IS NULL OR (scope = 'space' AND holder = 'https://rezics.com/id/' || creation_admission::text)),
  CHECK (NOT access.has_address_sid_case_variant(key) AND NOT access.has_address_sid_case_variant(display)),
  CHECK (NOT (substr(key,23,1) = '-' AND access.has_address_sid_case_variant(substr(key,1,22)))),
  CHECK (NOT (substr(display,23,1) = '-' AND access.has_address_sid_case_variant(substr(display,1,22)))),
  CHECK (key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  CHECK (successor IS NULL OR (state = 'redirect' AND successor <> holder))
);
CREATE UNIQUE INDEX name_registry_current_holder ON access.name_registry(scope,holder) WHERE state = 'current';
CREATE INDEX name_registry_holder_head ON access.name_registry
 (scope,holder,(state = 'current') DESC,changed_at DESC,revision DESC);
CREATE INDEX name_registry_skeleton ON access.name_registry(scope,skeleton,holder,controller);
CREATE INDEX name_registry_handle_skeleton ON access.name_registry(skeleton,controller,holder) WHERE scope IN ('agent','space');
CREATE TABLE access.name_history (
  revision uuid PRIMARY KEY,
  scope text NOT NULL,
  key text NOT NULL,
  holder text NOT NULL,
  display text NOT NULL,
  state text NOT NULL,
  successor text,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(scope,key) REFERENCES access.name_registry(scope,key)
);
CREATE INDEX name_history_name ON access.name_history(scope,key,recorded_at,revision);
CREATE TABLE access.name_receipt (
  principal_id uuid NOT NULL REFERENCES access.principal(id),
  idempotency_key text NOT NULL,
  request_digest text NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY(principal_id,idempotency_key)
);

INSERT INTO access.name_registry(scope,key,display,skeleton,holder,controller,state,claimed_at,changed_at)
 SELECT 'agent',handle,handle,skeleton,agent_id,agent_id,
   CASE WHEN state = 'current' THEN 'current' ELSE 'redirect' END,claimed_at,claimed_at
 FROM access.agent_handle
 WHERE NOT access.has_address_sid_case_variant(handle)
   AND NOT EXISTS (SELECT 1 FROM access.name_reserved_word WHERE word = handle AND handles);
DO $$ DECLARE skipped record; BEGIN
 FOR skipped IN SELECT handle,agent_id FROM access.agent_handle
   WHERE access.has_address_sid_case_variant(handle)
     OR EXISTS (SELECT 1 FROM access.name_reserved_word WHERE word = handle AND handles)
 LOOP RAISE WARNING 'Skipped legacy Agent name %, holder % uses its identity address',skipped.handle,skipped.agent_id; END LOOP;
END $$;
INSERT INTO access.name_history(revision,scope,key,holder,display,state)
 SELECT revision,scope,key,holder,display,state FROM access.name_registry;
DROP TABLE access.agent_handle_receipt;
DROP TABLE access.agent_handle;
CREATE INDEX realm_member_name_registry_search ON access.name_registry USING gin
 (access.realm_member_search_terms(access.realm_member_search_key(key)))
 WITH (fastupdate = off)
 WHERE scope = 'agent' AND state = 'current';
-- UNION makes this view non-updatable, including for the table owner.
CREATE VIEW access.agent_handle AS
 SELECT key AS handle,holder AS agent_id,
   CASE WHEN state = 'current' THEN 'current' ELSE 'retired' END AS state,
   claimed_at,CASE WHEN state = 'current' THEN NULL ELSE 'infinity'::timestamptz END AS retired_until,
   skeleton FROM access.name_registry WHERE scope = 'agent'
 UNION ALL
 SELECT NULL::text,NULL::text,NULL::text,NULL::timestamptz,NULL::timestamptz,NULL::text WHERE false;
COMMENT ON VIEW access.agent_handle IS
 'Read-only bridge for services/main/src/modules/notification-producers/producer.ts:444 (G-938). Remove once that reader uses the name registry.';

-- A trigger is the last guard against a future adapter deleting an alias or
-- reassigning it to somebody else. History is immutable, including to its owner.
CREATE FUNCTION access.retain_name_holder() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' OR NEW.scope <> OLD.scope OR NEW.key <> OLD.key THEN
   RAISE EXCEPTION 'Name ownership is permanent' USING ERRCODE = '23514';
 END IF;
 IF NEW.holder <> OLD.holder AND NOT (OLD.scope = 'space' AND OLD.state = 'retired'
   AND NEW.controller = OLD.controller AND EXISTS (SELECT 1 FROM access.admission a
     WHERE a.id = OLD.creation_admission AND a.action = 'space.create' AND a.acting_subject = OLD.controller
       AND a.state = 'sealed' AND a.graph_outcome = 'cancelled')) THEN
   RAISE EXCEPTION 'Name ownership is permanent' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER retain_name_holder BEFORE UPDATE OR DELETE ON access.name_registry
 FOR EACH ROW EXECUTE FUNCTION access.retain_name_holder();
CREATE FUNCTION access.reject_name_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Name history is immutable' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER immutable_name_history BEFORE UPDATE OR DELETE ON access.name_history
 FOR EACH ROW EXECUTE FUNCTION access.reject_name_history_change();
