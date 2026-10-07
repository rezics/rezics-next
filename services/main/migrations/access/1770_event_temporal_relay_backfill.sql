-- Earlier populated backfills skipped retained history and enumerated a sorted
-- graph inventory. Replay the indexed owner journal once; exact applied heads
-- preserve interval/bucket idempotency while coverage remains explicit.
UPDATE access.event_temporal_checkpoint SET relay_sequence=0,
    backfill_complete=false,processed=0,actual_revision='',planned_revision='';
ALTER TABLE access.event_temporal_checkpoint DROP COLUMN backfill_event,
    DROP COLUMN backfill_status;
