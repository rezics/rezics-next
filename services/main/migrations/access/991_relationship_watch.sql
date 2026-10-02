-- Preserve proposal identities, CAS revisions, reasons and ignores while
-- replacing the proposal-only inventory with one Watch owner.
ALTER TABLE access.proposal_subscription RENAME TO watch;
DROP TRIGGER proposal_subscription_guard ON access.watch;
ALTER TABLE access.watch DROP CONSTRAINT proposal_subscription_pkey,
  DROP CONSTRAINT proposal_subscription_level_check,
  ALTER COLUMN proposal DROP NOT NULL,
  ADD COLUMN target text,
  ADD COLUMN kind text NOT NULL DEFAULT 'proposal' CHECK(kind IN ('thread','proposal','release','collection')),
  ADD CONSTRAINT watch_level_check CHECK(level IN ('participating','all','ignore'));
UPDATE access.watch SET target='urn:rezics:proposal:' || proposal::text;
-- A manual proposal subscription meant all lifecycle updates; retain that
-- intent in the general Watch vocabulary rather than inventing participation.
UPDATE access.watch SET level='all' WHERE reason='manual' AND level='participating';
ALTER TABLE access.watch ALTER COLUMN target SET NOT NULL,
  ADD PRIMARY KEY(principal_id,target),
  ADD CONSTRAINT watch_proposal_identity CHECK((kind='proposal')=(proposal IS NOT NULL)
    AND (proposal IS NULL OR target='urn:rezics:proposal:' || proposal::text));
CREATE INDEX watch_target_recipients ON access.watch(target,principal_id);
CREATE TABLE access.watch_participation(principal_id uuid NOT NULL REFERENCES access.principal(id),
  target text NOT NULL,PRIMARY KEY(principal_id,target));
INSERT INTO access.watch_participation(principal_id,target)
  SELECT principal_id,target FROM access.watch WHERE reason<>'manual';
CREATE FUNCTION access.guard_watch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' AND NEW.proposal IS NOT NULL THEN NEW.target:='urn:rezics:proposal:' || NEW.proposal::text; END IF;
  IF TG_OP='DELETE' OR TG_OP='INSERT' AND NEW.revision<>1 OR TG_OP='UPDATE' AND
    (NEW.principal_id<>OLD.principal_id OR NEW.target<>OLD.target OR NEW.kind<>OLD.kind
      OR NEW.reason<>OLD.reason OR NEW.revision<>OLD.revision+1) THEN
    RAISE EXCEPTION 'watch identity is stable and revision advances once' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER watch_guard BEFORE INSERT OR UPDATE OR DELETE ON access.watch
  FOR EACH ROW EXECUTE FUNCTION access.guard_watch();
-- Transitional transport adapter; this view stores no second relationship.
CREATE VIEW access.proposal_subscription AS SELECT principal_id,proposal,reason,level,revision
  FROM access.watch WHERE kind='proposal';
CREATE OR REPLACE FUNCTION access.subscribe_proposal_participant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='editorial_proposal' THEN
    INSERT INTO access.watch(principal_id,proposal,reason,level)
      VALUES(NEW.proposer_principal,NEW.id,'author','participating') ON CONFLICT DO NOTHING;
    INSERT INTO access.watch_participation(principal_id,target)
      VALUES(NEW.proposer_principal,'urn:rezics:proposal:' || NEW.id::text) ON CONFLICT DO NOTHING;
  ELSE
    INSERT INTO access.watch(principal_id,proposal,reason,level)
      VALUES(NEW.principal,NEW.proposal,'reviewer','participating') ON CONFLICT DO NOTHING;
    INSERT INTO access.watch_participation(principal_id,target)
      VALUES(NEW.principal,'urn:rezics:proposal:' || NEW.proposal::text) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TABLE access.watch_receipt(principal_id uuid NOT NULL REFERENCES access.principal(id),
  idempotency_key text NOT NULL,request_digest text NOT NULL,result jsonb NOT NULL,
  PRIMARY KEY(principal_id,idempotency_key));
CREATE TRIGGER watch_receipt_immutable BEFORE UPDATE OR DELETE ON access.watch_receipt
  FOR EACH ROW EXECUTE FUNCTION access.reject_notification_mutation();
