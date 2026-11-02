-- migrate:up
-- The terminal slot remains an exact replay fence after disposable order locators are minimized.
ALTER TABLE commerce.creator_sale_receipt ALTER COLUMN order_id DROP NOT NULL;
ALTER TABLE commerce.creator_sale_receipt ALTER COLUMN source_revision DROP NOT NULL;
CREATE INDEX creator_sale_receipt_event ON commerce.creator_sale_receipt(partition_no,event_id);
-- Trusted checkout commands deliberately have no actor write basis. Their genuine
-- native commit receipt supplies only provenance, never a worker principal/grant.
CREATE UNIQUE INDEX commerce_live_copy_receipt_transaction ON core.receipt(partition_no,transaction_id)
 WHERE principal_kind='account' AND command_kind IN ('commerce.checkout.record','commerce.checkout.refresh','commerce.checkout.apply');
CREATE UNIQUE INDEX commerce_live_copy_receipt_position ON core.receipt(partition_no,position)
 WHERE principal_kind='account' AND command_kind IN ('commerce.checkout.record','commerce.checkout.refresh','commerce.checkout.apply');
ALTER TABLE commerce.creator_sales_frontier ADD COLUMN next_run timestamptz NOT NULL DEFAULT now();
-- The exact current native receiving transaction is required even for old prepared DAO calls.
CREATE FUNCTION commerce.guard_live_copy_sale() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM access.live_copy_gate g
   WHERE g.route=NEW.route AND g.applying_transaction=pg_current_xact_id() AND g.outcome='applying'
     AND g.module='commerce.creator-sale' AND NOT g.retired
     AND g.payload->>'creatorAccountId'=NEW.creator_account_id::text
     AND g.payload->'view'->>'orderId'=NEW.order_id::text
     AND g.payload->'view'->>'offerId'=NEW.offer_id::text
     AND g.payload->'view'->>'targetSubjectId'=NEW.target_subject_id::text
     AND g.payload->'view'->>'title'=NEW.title AND g.payload->'view'->>'currency'=NEW.currency
     AND (g.payload->'view'->>'unitAmountMinor')::bigint=NEW.unit_amount_minor
     AND NULLIF(g.payload->'view'->'moneyUnit','null'::jsonb) IS NOT DISTINCT FROM NEW.money_unit
     AND g.payload->'view'->>'taxBehavior' IS NOT DISTINCT FROM NEW.tax_behavior
     AND g.payload->'view'->>'settlement'=NEW.settlement
     AND (g.payload->'view'->>'createdAt')::timestamptz=NEW.created_at
     AND (g.payload->>'revision')::integer=NEW.source_revision
     AND g.payload->>'transactionId'=NEW.source_transaction_id::text
     AND (g.payload->>'epoch')::bigint=NEW.source_epoch
     AND (g.payload->>'position')::bigint=NEW.source_position
     AND (g.payload->>'eventSeq')::integer=NEW.source_event_seq
     AND g.payload->>'eventId'=NEW.source_event_id::text) THEN
  RAISE EXCEPTION 'Creator sale write requires native live receiving gate' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND (NEW.route,NEW.creator_account_id,NEW.order_id)
    IS DISTINCT FROM (OLD.route,OLD.creator_account_id,OLD.order_id) THEN
  RAISE EXCEPTION 'Creator sale identity is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER live_copy_sale_guard BEFORE INSERT OR UPDATE ON commerce.creator_sale
 FOR EACH ROW EXECUTE FUNCTION commerce.guard_live_copy_sale();
-- New producer-owned personal locators and their role inverses commit together.
-- Existing rows are covered by bounded native work/receipt frontiers instead.
CREATE FUNCTION commerce.live_copy_intent_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE buyer uuid; creator uuid; intent_key jsonb; intent_kind text; buyer_state text; fenced boolean;
BEGIN
 IF NEW.order_id IS NULL THEN RETURN NULL; END IF;
 SELECT o.buyer_account_id,o.creator_account_id,a.state,a.authn_fenced INTO buyer,creator,buyer_state,fenced
   FROM commerce.purchase_order o JOIN access.account a ON (a.route,a.account_id)=(o.route,o.buyer_account_id)
   WHERE o.route=NEW.route AND o.order_id=NEW.order_id FOR UPDATE OF a FOR SHARE OF o;
 IF NOT FOUND THEN RAISE EXCEPTION 'Commerce intent requires native business roles' USING ERRCODE='23514'; END IF;
 IF buyer_state<>'active' OR fenced THEN
  RAISE EXCEPTION 'Commerce intent requires active native source account' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME='creator_sale_work' THEN
  intent_kind:='commerce-work'; intent_key:=jsonb_build_object('orderId',NEW.order_id);
 ELSE
  intent_kind:='commerce-receipt'; intent_key:=jsonb_build_object('partition',NEW.partition_no,'position',NEW.position::text,'eventSeq',NEW.event_seq);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM access.live_copy_business_inventory i WHERE i.route=NEW.route AND i.account_id=buyer AND i.kind=intent_kind AND i.locator=intent_key)
   OR NOT EXISTS(SELECT 1 FROM access.live_copy_business_inventory i WHERE i.route=NEW.route AND i.account_id=creator AND i.kind=intent_kind AND i.locator=intent_key) THEN
  RAISE EXCEPTION 'Commerce intent requires committed native role inventory' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER live_copy_work_commit AFTER INSERT ON commerce.creator_sale_work
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.live_copy_intent_commit();
CREATE CONSTRAINT TRIGGER live_copy_receipt_commit AFTER INSERT ON commerce.creator_sale_receipt
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.live_copy_intent_commit();
CREATE FUNCTION commerce.preserve_live_copy_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='creator_sale_work' THEN
  IF (NEW.route,NEW.order_id)=(OLD.route,OLD.order_id) THEN RETURN NEW; END IF;
 ELSE
  IF (NEW.partition_no,NEW.position,NEW.event_seq,NEW.epoch,NEW.event_id,NEW.route)
     =(OLD.partition_no,OLD.position,OLD.event_seq,OLD.epoch,OLD.event_id,OLD.route)
    AND ((NEW.order_id,NEW.source_revision,NEW.state) IS NOT DISTINCT FROM (OLD.order_id,OLD.source_revision,OLD.state)
      OR (NEW.order_id IS NULL AND NEW.source_revision IS NULL AND NEW.state='minimized')) THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'Commerce live copy intent identity is immutable' USING ERRCODE='23514';
END; $$;
CREATE TRIGGER live_copy_work_identity BEFORE UPDATE ON commerce.creator_sale_work
 FOR EACH ROW EXECUTE FUNCTION commerce.preserve_live_copy_intent();
CREATE TRIGGER live_copy_receipt_identity BEFORE UPDATE ON commerce.creator_sale_receipt
 FOR EACH ROW EXECUTE FUNCTION commerce.preserve_live_copy_intent();
-- migrate:down
-- Forward only: minimized personal locators cannot be reconstructed.
