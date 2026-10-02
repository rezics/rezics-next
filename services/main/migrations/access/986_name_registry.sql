-- One permanent name inventory. Slugs are derived and are never persisted here.
CREATE TABLE access.name_scope_policy (
  scope_kind text PRIMARY KEY CHECK (scope_kind IN ('agent','space','work','zone')),
  characters text NOT NULL CHECK (characters IN ('ascii-handle','unicode-title')),
  canonical text NOT NULL DEFAULT 'name' CHECK (canonical IN ('name','id')),
  cooldown_days integer NOT NULL DEFAULT 0 CHECK (cooldown_days >= 0),
  reserved text[] NOT NULL DEFAULT '{}'
);
INSERT INTO access.name_scope_policy(scope_kind,characters,cooldown_days,reserved) VALUES
 ('agent','ascii-handle',30,ARRAY['admin','administrator','api','auth','official','rezics','root','staff','support','system','security','moderator','moderators','help','account','accounts','settings','profile','discover','search','login','signup','register','billing','owner','webmaster','postmaster','abuse','contact','recovery','team','trust','safety','new','create','home','me','users','agents','spaces','realms','zones','handles','health','inbox','notifications','library','groups','studio','identity','locale','works','shelves','v1']),
 ('space','ascii-handle',0,ARRAY['admin','administrator','api','auth','official','rezics','root','staff','support','system','security','moderator','moderators','help','account','accounts','settings','profile','discover','search','login','signup','register','billing','owner','webmaster','postmaster','abuse','contact','recovery','team','trust','safety','new','create','home','me','users','agents','spaces','realms','zones','handles','health','inbox','notifications','library','groups','studio','identity','locale','works','shelves','v1']),
 ('work','unicode-title',0,ARRAY['new','create']),
 ('zone','unicode-title',0,ARRAY['new','create']);

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
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope,key),
  CHECK (NOT access.is_address_sid(key) AND NOT access.is_address_sid(display)),
  CHECK (NOT (substr(key,23,1) = '-' AND access.is_address_sid(substr(key,1,22)))),
  CHECK (NOT (substr(display,23,1) = '-' AND access.is_address_sid(substr(display,1,22)))),
  CHECK (key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  CHECK (successor IS NULL OR (state = 'redirect' AND successor <> holder))
);
CREATE UNIQUE INDEX name_registry_current_holder ON access.name_registry(scope,holder) WHERE state = 'current';
CREATE INDEX name_registry_skeleton ON access.name_registry(scope,skeleton,controller,holder);
CREATE INDEX name_registry_handle_skeleton ON access.name_registry(skeleton,controller) WHERE scope IN ('agent','space');
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
 FROM access.agent_handle;
INSERT INTO access.name_history(revision,scope,key,holder,display,state)
 SELECT revision,scope,key,holder,display,state FROM access.name_registry;
DROP TABLE access.agent_handle_receipt;
DROP TABLE access.agent_handle;
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
 IF TG_OP = 'DELETE' OR NEW.scope <> OLD.scope OR NEW.key <> OLD.key OR NEW.holder <> OLD.holder THEN
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
