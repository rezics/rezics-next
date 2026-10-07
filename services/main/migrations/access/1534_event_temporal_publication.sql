-- Event admissions publish their conservative effect before graph dispatch.
-- These are pending effects in the existing consumer, not another journal.
ALTER TABLE access.event_temporal_window_update
  ADD COLUMN publication_receipt text,
  ADD COLUMN publication_admission uuid,
  ADD COLUMN publication_digest text,
  ADD COLUMN publication_expiry timestamptz,
  ADD COLUMN publication_authority_epoch text,
  ADD COLUMN publication_sequence numeric;
CREATE UNIQUE INDEX event_temporal_publication_receipt
  ON access.event_temporal_window_update (publication_receipt)
  WHERE publication_receipt IS NOT NULL;
CREATE INDEX event_temporal_publication_retry
  ON access.event_temporal_window_update (work_at,id)
  WHERE publication_receipt IS NOT NULL AND publication_sequence IS NULL;
CREATE INDEX event_temporal_publication_target
  ON access.event_temporal_window_update (event,time_status,publication_sequence,id)
  WHERE publication_receipt IS NOT NULL;
CREATE INDEX event_temporal_ordinary_target_order
  ON access.event_temporal_window_update (event,time_status,id DESC)
  WHERE publication_receipt IS NULL;
CREATE INDEX event_temporal_delivered_publication
  ON access.event_temporal_window_update (work_at,id)
  WHERE publication_receipt IS NOT NULL AND publication_sequence IS NOT NULL;
CREATE INDEX event_temporal_publication_civil
  ON access.event_temporal_window_update USING gist (civil_effect,target)
  WHERE publication_receipt IS NOT NULL;
CREATE INDEX event_temporal_publication_instant
  ON access.event_temporal_window_update USING gist (instant_effect,target)
  WHERE publication_receipt IS NOT NULL;
CREATE INDEX event_temporal_publication_unsupported
  ON access.event_temporal_window_update USING gist (unsupported_effect,target)
  WHERE publication_receipt IS NOT NULL;
CREATE INDEX event_temporal_publication_actual_civil
  ON access.event_temporal_window_update USING gist (civil_effect,target)
  WHERE publication_receipt IS NOT NULL AND time_status='actual';
CREATE INDEX event_temporal_publication_planned_civil
  ON access.event_temporal_window_update USING gist (civil_effect,target)
  WHERE publication_receipt IS NOT NULL AND time_status='planned';
CREATE INDEX event_temporal_publication_actual_instant
  ON access.event_temporal_window_update USING gist (instant_effect,target)
  WHERE publication_receipt IS NOT NULL AND time_status='actual';
CREATE INDEX event_temporal_publication_planned_instant
  ON access.event_temporal_window_update USING gist (instant_effect,target)
  WHERE publication_receipt IS NOT NULL AND time_status='planned';
CREATE INDEX event_temporal_publication_actual_unsupported
  ON access.event_temporal_window_update USING gist (unsupported_effect,target)
  WHERE publication_receipt IS NOT NULL AND time_status='actual';
CREATE INDEX event_temporal_publication_planned_unsupported
  ON access.event_temporal_window_update USING gist (unsupported_effect,target)
  WHERE publication_receipt IS NOT NULL AND time_status='planned';
ALTER TABLE access.event_temporal_pending ADD COLUMN receipt_id text;
ALTER TABLE access.event_temporal_pending ADD COLUMN effect_registered boolean NOT NULL DEFAULT false;
CREATE INDEX event_temporal_unknown_effect
  ON access.event_temporal_pending (time_status,event,state)
  WHERE NOT effect_registered;
-- A pre-seam window may have been built before required old effects applied.
-- Rebuild once from the existing fixed initial coverage proof.
TRUNCATE access.event_temporal_member,access.event_temporal_bucket;
UPDATE access.event_temporal_window SET state='queued',scan_started_at=NULL,
  after_event=NULL,after_status=NULL,processed=0,revision=revision+1,
  actual_revision=actual_revision+1,planned_revision=planned_revision+1,
  unsupported_actual_count=0,unsupported_planned_count=0;
