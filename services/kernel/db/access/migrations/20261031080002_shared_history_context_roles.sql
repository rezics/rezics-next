-- migrate:up
-- Native Access provenance. A historical row is evidence of an occurrence, never current authority.
CREATE TABLE access.resource_role_provenance (
  route integer NOT NULL, occurrence bigint GENERATED ALWAYS AS IDENTITY,
  resource_id uuid NOT NULL, resource_type text NOT NULL, original_creator uuid NOT NULL,
  account_id uuid NOT NULL, grant_role text NOT NULL, valid tstzrange,
  side text NOT NULL CHECK(side IN ('creator','new','former')),
  grant_transaction uuid, source_transaction uuid NOT NULL,
  context_key bigint,
  delivery text NOT NULL DEFAULT 'pending' CHECK(delivery IN ('pending','delivered','not-applicable')),
  PRIMARY KEY(route,occurrence),
  CHECK(route BETWEEN 0 AND 65535)
);
CREATE INDEX resource_role_provenance_account ON access.resource_role_provenance(route,account_id,occurrence);
CREATE INDEX resource_role_provenance_delivery ON access.resource_role_provenance(route,occurrence) WHERE delivery='pending';

CREATE FUNCTION access.capture_resource_role_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r access.resource_role_grant; i access.resource_initialization; native_tx uuid;
BEGIN
 IF TG_OP='DELETE' THEN r:=OLD; ELSE r:=NEW; END IF;
 IF r.subject_kind<>'identity' OR r.subject_role<>'' THEN RETURN r; END IF;
 SELECT * INTO i FROM access.resource_initialization WHERE route=r.route AND resource_id=r.resource_id;
 IF NOT FOUND THEN RETURN r; END IF;
 native_tx:=coalesce(nullif(current_setting('access.role_native_transaction',true),'' )::uuid,r.transaction_id);
 INSERT INTO access.resource_role_provenance(route,resource_id,resource_type,original_creator,account_id,
   grant_role,valid,side,grant_transaction,source_transaction)
 VALUES(r.route,r.resource_id,i.resource_type,i.creator_id,r.subject_id,r.grant_role,r.valid,
   CASE WHEN TG_OP='DELETE' THEN 'former' ELSE 'new' END,r.transaction_id,native_tx);
 RETURN r;
END; $$;
CREATE FUNCTION access.deliver_resource_role_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k bigint;
BEGIN
 -- The actual Semantic sink, including its normal home invalidation/delivery/late-item protocol.
 -- A role string alone never establishes the resource's type.
 IF NEW.resource_type='semantic.context' AND NEW.grant_role='semantic.context.owner' THEN
   SELECT erasure_key INTO k FROM semantic.context WHERE route=NEW.route AND context_id=NEW.resource_id;
   IF k IS NOT NULL THEN
     PERFORM semantic.record_erasure_locator(NEW.route/16,NEW.account_id,'owner','context',k,NEW.source_transaction,NULL);
     UPDATE access.resource_role_provenance SET context_key=k,delivery='delivered'
       WHERE route=NEW.route AND occurrence=NEW.occurrence;
   END IF;
 ELSE
   UPDATE access.resource_role_provenance SET delivery='not-applicable' WHERE route=NEW.route AND occurrence=NEW.occurrence;
 END IF;
 RETURN NEW;
END; $$;
-- Capture OLD before its destructive removal, and NEW after its authoritative insert.
CREATE TRIGGER resource_role_provenance_old BEFORE DELETE ON access.resource_role_grant
 FOR EACH ROW EXECUTE FUNCTION access.capture_resource_role_provenance();
CREATE TRIGGER resource_role_provenance_new AFTER INSERT ON access.resource_role_grant
 FOR EACH ROW EXECUTE FUNCTION access.capture_resource_role_provenance();
-- Delivery observes the command's actual committed envelope position, after its fence writes.
CREATE CONSTRAINT TRIGGER resource_role_provenance_deliver AFTER INSERT ON access.resource_role_provenance
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION access.deliver_resource_role_provenance();

-- migrate:down
-- Historical ownership cannot be reconstructed after destructive mutations.
