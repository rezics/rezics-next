-- migrate:up
CREATE OR REPLACE FUNCTION semantic.retain_public_filter_repair_ack() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.verified_home IS NOT NULL AND NEW.verified_home IS DISTINCT FROM OLD.verified_home)
    OR NEW.ack_after<OLD.ack_after OR NEW.ack_after>OLD.ack_after+16
    OR (NEW.ack_after<>OLD.ack_after AND
      (NOT OLD.complete OR OLD.verified_root IS NULL OR OLD.verified_next IS NOT NULL)) THEN
    RAISE EXCEPTION 'Original repair window and contiguous ACK progress cannot be replaced'
      USING ERRCODE='23514';
  END IF;
  IF NEW.ack_after>OLD.ack_after AND NOT EXISTS (
    SELECT 1
    FROM semantic.public_filter_bootstrap cut
    JOIN core.partition p ON p.partition_no=cut.partition_no
    JOIN semantic.public_filter_home_enrollment e ON e.bootstrap=cut.bootstrap
    JOIN search.public_filter_coverage_home h
      ON (h.partition_no,h.registration,h.source_home)=(e.registration_partition,e.registration,e.partition_no)
    JOIN search.public_filter_coverage_baseline b
      ON (b.partition_no,b.registration,b.bootstrap,b.source_home)=
         (e.registration_partition,e.registration,e.bootstrap,e.partition_no)
    WHERE (cut.partition_no,cut.bootstrap)=(OLD.partition_no,OLD.bootstrap)
      AND cut.owner_epoch=p.epoch AND p.write_state='active' AND cut.state='adopted'
      AND e.partition_no>=OLD.ack_after AND e.partition_no<NEW.ack_after
      AND e.complete AND e.read_definition=cut.read_definition AND b.receipt=e.receipt
      AND h.source_epoch=e.owner_epoch AND h.baseline_bootstrap=e.bootstrap
      AND h.acknowledged_baseline=e.bootstrap AND h.acknowledged_position>=b.source_position
      AND h.acknowledged_observation=cut.queried AND h.acknowledged_execution=OLD.execution
      AND h.acknowledged_settlement IS NOT NULL
      AND h.acknowledged_native_enqueue>=b.native_enqueue_revision
      AND h.acknowledged_native_revision IS NOT DISTINCT FROM b.native_revision
      AND h.acknowledged_native_claim_revision IS NOT DISTINCT FROM b.native_claim_revision
    HAVING count(*)=NEW.ack_after-OLD.ack_after AND count(DISTINCT h.acknowledged_settlement)=1
  ) THEN
    RAISE EXCEPTION 'Contiguous Source ACK progress requires every original receiver receipt'
      USING ERRCODE='23514', CONSTRAINT='public_filter_repair_ack_receiver_prefix';
  END IF;
  RETURN NEW;
END $$;

-- migrate:down
DO $$ BEGIN
  RAISE EXCEPTION 'Retained native repair ACK requires original Source retirement';
END $$;
