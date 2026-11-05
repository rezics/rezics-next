-- migrate:up
-- The Semantic record_erasure_locator sink has not been delivered. Preserve native OLD/NEW
-- provenance and leave Context-owner custody pending until the owner supplies its real port.
CREATE OR REPLACE FUNCTION access.deliver_resource_role_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.resource_type='semantic.context' AND NEW.grant_role='semantic.context.owner' THEN
   RETURN NEW;
 END IF;
 UPDATE access.resource_role_provenance SET delivery='not-applicable'
   WHERE route=NEW.route AND occurrence=NEW.occurrence;
 RETURN NEW;
END; $$;

-- migrate:down
-- Restore the prior owner-sink call only when rolling back alongside its delivered Semantic ABI.
CREATE OR REPLACE FUNCTION access.deliver_resource_role_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k bigint;
BEGIN
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
