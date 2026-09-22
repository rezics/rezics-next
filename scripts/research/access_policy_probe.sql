-- Feasibility probe, not the production Access schema or evaluator.
-- Trusted fixture writes stand in for admission/consent/grant-management commands.
SET statement_timeout = '5s';
CREATE TABLE subject (
  id text PRIMARY KEY, kind text NOT NULL,
  admitted boolean NOT NULL DEFAULT true,
  hard_blocked boolean NOT NULL DEFAULT false
);
CREATE TABLE scope (id text PRIMARY KEY, parent text REFERENCES scope(id));
CREATE TABLE representation (
  source text REFERENCES subject(id), target text REFERENCES subject(id),
  scope_id text REFERENCES scope(id), actions text[] NOT NULL,
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (source, target, scope_id)
);
CREATE TABLE access_grant (
  id text PRIMARY KEY, issuer text REFERENCES subject(id),
  recipient text REFERENCES subject(id), scope_id text REFERENCES scope(id),
  action text NOT NULL, may_delegate boolean NOT NULL DEFAULT false,
  lifetime text NOT NULL CHECK (lifetime IN ('assignment', 'dependent')),
  parent_id text REFERENCES access_grant(id), active boolean NOT NULL DEFAULT true,
  issued_by text REFERENCES subject(id)
);
CREATE INDEX grant_recipient_scope_action ON access_grant(recipient, scope_id, action);
CREATE TABLE realm_set (id text PRIMARY KEY, available boolean NOT NULL DEFAULT true);
CREATE TABLE membership (
  realm text REFERENCES realm_set(id), member text REFERENCES subject(id),
  active boolean NOT NULL DEFAULT true, PRIMARY KEY (realm, member)
);
CREATE TABLE policy_rule (
  id text PRIMARY KEY, scope_id text REFERENCES scope(id), position integer NOT NULL,
  effect text NOT NULL CHECK (effect IN ('allow','deny')),
  condition text NOT NULL CHECK (condition IN ('actor','realm_member','grant','always')),
  operand text, basis text CHECK (basis IN ('principal','actor')),
  UNIQUE (scope_id, position)
);
CREATE TABLE muted_realm (
  viewer text REFERENCES subject(id), realm text REFERENCES realm_set(id),
  PRIMARY KEY (viewer, realm)
);

CREATE FUNCTION scope_chain(root text) RETURNS TABLE(id text) LANGUAGE sql STABLE AS $$
  WITH RECURSIVE chain(id,parent,path) AS (
    SELECT id,parent,ARRAY[id] FROM scope WHERE id=root
    UNION ALL
    SELECT s.id,s.parent,c.path||s.id FROM scope s JOIN chain c ON s.id=c.parent
    WHERE NOT s.id=ANY(c.path)
  ) SELECT id FROM chain;
$$;

CREATE FUNCTION can_represent(p text,a text,s text,op text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH RECURSIVE walk(id,path) AS (
    SELECT id,ARRAY[id] FROM subject
    WHERE id=p AND kind='principal' AND admitted AND NOT hard_blocked
    UNION ALL
    SELECT r.target,w.path||r.target FROM walk w
    JOIN representation r ON r.source=w.id
    JOIN subject target ON target.id=r.target AND target.admitted AND NOT target.hard_blocked
    WHERE r.active AND op=ANY(r.actions)
      AND r.scope_id IN (SELECT id FROM scope_chain(s))
      AND NOT r.target=ANY(w.path)
  ) SELECT EXISTS(SELECT 1 FROM walk WHERE id=a);
$$;

CREATE FUNCTION live_grant(gid text) RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH RECURSIVE chain(id,lifetime,parent_id,active,may_delegate,path,valid) AS (
    SELECT id,lifetime,parent_id,active,may_delegate,ARRAY[id],active
    FROM access_grant WHERE id=gid
    UNION ALL
    SELECT g.id,g.lifetime,g.parent_id,g.active,g.may_delegate,c.path||g.id,
           c.valid AND g.active AND g.may_delegate
    FROM chain c JOIN access_grant g ON g.id=c.parent_id
    WHERE c.lifetime='dependent' AND NOT g.id=ANY(c.path)
  ) SELECT EXISTS(SELECT 1 FROM chain WHERE lifetime='assignment' AND valid);
$$;

CREATE FUNCTION has_grant(a text,s text,op text,delegating boolean DEFAULT false)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM access_grant g WHERE recipient=a AND action=op
    AND scope_id IN (SELECT id FROM scope_chain(s)) AND live_grant(g.id)
    AND (NOT delegating OR may_delegate));
$$;

CREATE FUNCTION decide(p text,a text,s text,op text)
RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE rule policy_rule; matches boolean; membership_known boolean;
BEGIN
  IF NOT can_represent(p,a,s,op) THEN RETURN 'deny'; END IF;
  FOR rule IN SELECT * FROM policy_rule
    WHERE scope_id IN (SELECT id FROM scope_chain(s)) ORDER BY position,id
  LOOP
    CASE rule.condition
      WHEN 'actor' THEN matches := a=rule.operand;
      WHEN 'always' THEN matches := true;
      WHEN 'grant' THEN matches := has_grant(a,s,op);
      WHEN 'realm_member' THEN
        SELECT available INTO membership_known FROM realm_set WHERE id=rule.operand;
        IF membership_known IS DISTINCT FROM true THEN RETURN 'unavailable'; END IF;
        SELECT EXISTS(SELECT 1 FROM membership WHERE realm=rule.operand AND active
          AND member=CASE rule.basis WHEN 'principal' THEN p ELSE a END) INTO matches;
    END CASE;
    IF matches THEN RETURN rule.effect; END IF;
  END LOOP;
  RETURN 'deny';
END;
$$;

CREATE FUNCTION assert_case(label text,actual text,expected text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION '%: expected %, received %', label,expected,actual;
  END IF;
  RAISE NOTICE 'PASS %',label;
END;
$$;

INSERT INTO subject(id,kind) VALUES
 ('p:alice','principal'),('p:bob','principal'),('p:carol','principal'),
 ('p:admin','principal'),('p:profile-editor','principal'),('p:limited','principal'),
 ('a:alice','agent'),('a:alternate','agent'),('a:bob','agent'),('a:carol','agent'),
 ('a:unclaimed','agent'),('o:wiki','agent'),('a:middle','agent'),('a:end','agent');
INSERT INTO subject(id,kind,admitted) VALUES ('work:passive','resource',false);
INSERT INTO scope VALUES ('wiki',NULL),('page','wiki'),('outside',NULL);
INSERT INTO representation(source,target,scope_id,actions) VALUES
 ('p:alice','a:alice','wiki',ARRAY['read','grant_read']),
 ('p:alice','a:alternate','wiki',ARRAY['read']),
 ('p:bob','a:bob','wiki',ARRAY['read']),
 ('p:carol','a:carol','wiki',ARRAY['read']),
 ('p:admin','o:wiki','wiki',ARRAY['read','grant_read']),
 ('p:limited','a:alice','wiki',ARRAY['read']),
 ('p:alice','a:middle','wiki',ARRAY['read']),
 ('a:middle','a:end','wiki',ARRAY['read']),
 ('p:alice','work:passive','wiki',ARRAY['read']);
INSERT INTO access_grant(id,issuer,recipient,scope_id,action,may_delegate,lifetime,issued_by) VALUES
 ('g:a','o:wiki','a:alice','wiki','read',true,'assignment','p:admin'),
 ('g:c','o:wiki','a:carol','wiki','read',false,'assignment','p:admin'),
 ('g:p','o:wiki','p:alice','wiki','read',false,'assignment','p:admin'),
 ('g:u','o:wiki','a:unclaimed','wiki','read',false,'assignment','p:admin');
INSERT INTO access_grant(id,issuer,recipient,scope_id,action,lifetime,parent_id,issued_by)
 VALUES ('g:b','a:alice','a:bob','page','read','dependent','g:a','p:alice');
INSERT INTO realm_set VALUES ('r:excluded',true),('r:private',false);
INSERT INTO policy_rule VALUES ('default','wiki',100,'allow','grant',NULL,NULL);

SELECT assert_case('author receives rights, represented principal exercises them',decide('p:alice','a:alice','page','read'),'allow');
SELECT assert_case('profile editing supplies no representation',decide('p:profile-editor','a:alice','page','read'),'deny');
SELECT assert_case('ordinary resource is not automatically a security subject',decide('p:alice','work:passive','page','read'),'deny');
SELECT assert_case('unclaimed author cannot be impersonated',decide('p:alice','a:unclaimed','page','read'),'deny');
SELECT assert_case('account rights do not leak into another acting identity',decide('p:alice','a:alternate','page','read'),'deny');
SELECT assert_case('representation is scoped',can_represent('p:alice','a:alice','outside','read')::text,'false');
SELECT assert_case('object can issue through admitted operator and grant ceiling',
 (can_represent('p:alice','a:alice','page','grant_read') AND has_grant('a:alice','page','read',true))::text,'true');
SELECT assert_case('read-only representative cannot issue grants',can_represent('p:limited','a:alice','page','grant_read')::text,'false');
SELECT assert_case('multiple representation edges can preserve one action',can_represent('p:alice','a:end','page','read')::text,'true');
UPDATE representation SET actions=ARRAY['grant_read'] WHERE source='a:middle';
SELECT assert_case('different edges cannot pool different action ceilings',can_represent('p:alice','a:end','page','read')::text,'false');
SELECT assert_case('live dependent delegation is usable',decide('p:bob','a:bob','page','read'),'allow');
UPDATE access_grant SET active=false WHERE id='g:a';
SELECT assert_case('revoking parent stops dependent delegation',decide('p:bob','a:bob','page','read'),'deny');
UPDATE access_grant SET active=true WHERE id='g:a';
UPDATE representation SET active=false WHERE source='p:admin';
SELECT assert_case('institutional assignment survives issuing operator departure',decide('p:carol','a:carol','page','read'),'allow');
INSERT INTO access_grant(id,issuer,recipient,scope_id,action,lifetime,issued_by)
 VALUES ('g:alt','o:wiki','a:alternate','wiki','read','assignment','p:admin');
INSERT INTO membership VALUES ('r:excluded','a:alice',true);
INSERT INTO policy_rule VALUES ('exclude','wiki',20,'deny','realm_member','r:excluded','actor');
SELECT assert_case('Realm actor exclusion overrides a lower-priority grant',decide('p:alice','a:alice','page','read'),'deny');
SELECT assert_case('actor-based exclusion permits distinct eligible identity',decide('p:alice','a:alternate','page','read'),'allow');
INSERT INTO membership VALUES ('r:excluded','p:alice',true);
UPDATE policy_rule SET basis='principal' WHERE id='exclude';
SELECT assert_case('principal-based exclusion survives identity switch',decide('p:alice','a:alternate','page','read'),'deny');
INSERT INTO policy_rule VALUES ('exception','wiki',10,'allow','actor','a:alice',NULL);
SELECT assert_case('earlier explicit exception wins under first-applicable',decide('p:alice','a:alice','page','read'),'allow');
UPDATE policy_rule SET position=30 WHERE id='exception';
SELECT assert_case('moving exception below exclusion changes result',decide('p:alice','a:alice','page','read'),'deny');
UPDATE policy_rule SET position=10 WHERE id='exception';
UPDATE subject SET hard_blocked=true WHERE id='p:alice';
SELECT assert_case('ordered exception cannot bypass mandatory guard',decide('p:alice','a:alice','page','read'),'deny');
UPDATE subject SET hard_blocked=false WHERE id='p:alice';
DELETE FROM policy_rule WHERE id='exception';
UPDATE policy_rule SET operand='r:private' WHERE id='exclude';
SELECT assert_case('unknown exclusion evidence cannot fall through to allow',decide('p:alice','a:alice','page','read'),'unavailable');
UPDATE policy_rule SET operand='r:excluded' WHERE id='exclude';
UPDATE membership SET active=false WHERE realm='r:excluded' AND member='p:alice';
SELECT assert_case('current-membership exclusion ends on qualified leave',decide('p:alice','a:alice','page','read'),'allow');
INSERT INTO muted_realm VALUES ('p:alice','r:excluded');
SELECT assert_case('reader mute does not revoke resource access',decide('p:alice','a:alice','page','read'),'allow');
SELECT assert_case('reader mute suppresses matching publisher in feed',
 (NOT EXISTS(SELECT 1 FROM muted_realm WHERE viewer='p:alice' AND realm='r:excluded'))::text,'false');
UPDATE representation SET active=false WHERE source='p:alice' AND target='a:alice';
SELECT assert_case('revoked representative loses use while object grant remains',decide('p:alice','a:alice','page','read'),'deny');
SELECT assert_case('object grant remains independently assigned',has_grant('a:alice','page','read')::text,'true');
