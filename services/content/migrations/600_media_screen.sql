-- New and retained originals fail closed until the local screen or staff clears them.
ALTER TABLE media.representation ADD COLUMN clearance text NOT NULL DEFAULT 'screening'
  CHECK (clearance IN ('screening', 'cleared', 'held', 'rejected')),
  ADD COLUMN clearance_reason text;
CREATE TABLE media.screen_result (
  job_id uuid PRIMARY KEY REFERENCES media.transform_job(id),
  source_id uuid NOT NULL UNIQUE REFERENCES media.representation(id),
  clearance text NOT NULL CHECK (clearance IN ('cleared', 'held')),
  reason text CHECK (reason IN ('likely-explicit', 'screen-unavailable')),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object' AND octet_length(evidence::text) <= 4096),
  operation_id text NOT NULL UNIQUE REFERENCES content.receipt(operation_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((clearance = 'held') = (reason IS NOT NULL))
);
CREATE TRIGGER screen_result_immutable BEFORE UPDATE OR DELETE ON media.screen_result
  FOR EACH ROW EXECUTE FUNCTION content.no_mutation();
CREATE TABLE media.screen_review (
  job_id uuid PRIMARY KEY REFERENCES media.screen_result(job_id),
  case_id uuid,
  retry_after timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX screen_review_pending ON media.screen_review (retry_after, job_id) WHERE case_id IS NULL;
CREATE TABLE media.clearance_decision (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES media.representation(id),
  decision_id uuid NOT NULL UNIQUE,
  clearance text NOT NULL CHECK (clearance IN ('cleared', 'rejected')),
  operation_id text NOT NULL UNIQUE REFERENCES content.receipt(operation_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER clearance_decision_immutable BEFORE UPDATE OR DELETE ON media.clearance_decision
  FOR EACH ROW EXECUTE FUNCTION content.no_mutation();
INSERT INTO content.receipt_action (action) VALUES ('media.screen.settle'), ('media.screen.review'),
  ('media.copy.suppress') ON CONFLICT DO NOTHING;

-- Separate requested and delivered selections: CAS still uses head, while a
-- pending replacement preserves the previous delivered image without history scans.
ALTER TABLE media.selection_slot ADD COLUMN delivery_head uuid;
ALTER TABLE media.selection_slot ADD CONSTRAINT selection_delivery_basis
  FOREIGN KEY (delivery_head, target, context, role)
  REFERENCES media.selection_revision(id, target, context, role);
CREATE FUNCTION media.delivery_clearance(p media.representation) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT o.clearance FROM media.representation o
    WHERE o.id = CASE WHEN p.kind = 'original' THEN p.id ELSE p.source_id END
$$;
-- Each requested slot resolves through constant primary-key probes. Clearance
-- settlement never updates an unbounded number of slots attached to one asset.
CREATE FUNCTION media.delivered_selection(s media.selection_slot) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN r.use_id IS NULL OR media.delivery_clearance(p) = 'cleared'
    THEN s.head ELSE s.delivery_head END
  FROM media.selection_revision r LEFT JOIN media.use u ON u.id = r.use_id
    LEFT JOIN media.representation p ON p.id = u.representation_id WHERE r.id = s.head
$$;
CREATE OR REPLACE FUNCTION media.settle_selection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE media.selection_slot s SET head = NEW.id,
    delivery_head = CASE WHEN NEW.use_id IS NULL THEN NEW.id
      WHEN EXISTS (SELECT 1 FROM media.use u JOIN media.representation p ON p.id = u.representation_id
        WHERE u.id = NEW.use_id AND media.delivery_clearance(p) = 'cleared') THEN NEW.id
      ELSE media.delivered_selection(s) END
    WHERE (target, context, role) = (NEW.target, NEW.context, NEW.role);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION media.representation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR
    (OLD.id, OLD.asset_id, OLD.kind, OLD.upload_id, OLD.source_id, OLD.transform_job_id,
      OLD.profile, OLD.crop, OLD.byte_digest, OLD.byte_length, OLD.media_type,
      OLD.pixel_width, OLD.pixel_height, OLD.operation_id, OLD.created_at)
    IS DISTINCT FROM (NEW.id, NEW.asset_id, NEW.kind, NEW.upload_id, NEW.source_id, NEW.transform_job_id,
      NEW.profile, NEW.crop, NEW.byte_digest, NEW.byte_length, NEW.media_type,
      NEW.pixel_width, NEW.pixel_height, NEW.operation_id, NEW.created_at)
    OR (OLD.availability IS DISTINCT FROM NEW.availability AND
      (OLD.availability <> 'available' OR NEW.availability = 'available')) THEN
    RAISE EXCEPTION 'immutable media representation' USING ERRCODE = '23514';
  END IF;
  IF (OLD.clearance, OLD.clearance_reason) IS DISTINCT FROM (NEW.clearance, NEW.clearance_reason) THEN
    IF NOT ((OLD.clearance = 'screening' AND EXISTS (SELECT 1 FROM media.screen_result r
          WHERE r.source_id = NEW.id AND r.clearance = NEW.clearance AND r.reason IS NOT DISTINCT FROM NEW.clearance_reason))
      OR EXISTS (SELECT 1 FROM media.clearance_decision d JOIN content.receipt r ON r.operation_id = d.operation_id
          WHERE d.source_id = NEW.id AND d.clearance = NEW.clearance AND r.action = 'media.screen.review'
            AND d.id = (SELECT latest.id FROM media.clearance_decision latest
              WHERE latest.source_id = NEW.id ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1)
            AND NEW.clearance_reason IS NOT DISTINCT FROM
              CASE WHEN d.clearance = 'rejected' THEN 'staff-rejected'::text ELSE NULL::text END)) THEN
      RAISE EXCEPTION 'media clearance requires fenced screen or staff decision' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION media.queue_screen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'original' AND NEW.clearance = 'screening' THEN
    INSERT INTO media.transform_job (id, asset_id, source_id, input_digest, profile,
      authority_epoch, erasure_epoch, operation_id)
    SELECT gen_random_uuid(), NEW.asset_id, NEW.id, NEW.byte_digest, 'image-screen-v1',
      s.authority_epoch, s.erasure_epoch, NEW.operation_id
    FROM media.asset a JOIN media.asset_state s ON s.id = a.state_head WHERE a.id = NEW.asset_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER representation_queue_screen AFTER INSERT ON media.representation
  FOR EACH ROW EXECUTE FUNCTION media.queue_screen();
CREATE FUNCTION media.apply_screen_result() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM media.transform_job j WHERE j.id = NEW.job_id
    AND j.profile = 'image-screen-v1' AND j.source_id = NEW.source_id
    AND (j.status = 'succeeded' OR (j.status = 'failed' AND j.reason = 'screen-unavailable'
      AND NEW.clearance = 'held' AND NEW.reason = 'screen-unavailable'))
    AND j.settle_operation_id = NEW.operation_id) THEN
    RAISE EXCEPTION 'screen result lacks fenced settlement' USING ERRCODE = '23514';
  END IF;
  UPDATE media.representation SET clearance = NEW.clearance, clearance_reason = NEW.reason
    WHERE id = NEW.source_id AND clearance = 'screening';
  IF NEW.clearance = 'held' THEN
    INSERT INTO media.screen_review (job_id) VALUES (NEW.job_id);

  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER screen_result_apply AFTER INSERT ON media.screen_result
  FOR EACH ROW EXECUTE FUNCTION media.apply_screen_result();
CREATE INDEX screen_selection_source ON media.use (representation_id, target, context) WHERE role = 'avatar';
-- Retained active originals are screened too; a migration never silently clears them.
INSERT INTO media.transform_job (id, asset_id, source_id, input_digest, profile,
  authority_epoch, erasure_epoch, operation_id)
SELECT gen_random_uuid(), p.asset_id, p.id, p.byte_digest, 'image-screen-v1',
  s.authority_epoch, s.erasure_epoch, p.operation_id
FROM media.representation p JOIN media.asset a ON a.id = p.asset_id
JOIN media.asset_state s ON s.id = a.state_head
WHERE p.kind = 'original' AND p.availability = 'available' AND s.lifecycle = 'active';

CREATE INDEX screen_job_ready ON media.transform_job (created_at, id)
  WHERE profile = 'image-screen-v1' AND status IN ('queued', 'leased');
CREATE INDEX screen_job_exhausted ON media.transform_job (lease_expires_at, id)
  WHERE profile = 'image-screen-v1' AND status = 'leased' AND attempt = 16;

CREATE INDEX clearance_decision_source ON media.clearance_decision (source_id, created_at DESC, id DESC);
CREATE FUNCTION media.apply_clearance_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE media.representation SET clearance = NEW.clearance,
    clearance_reason = CASE WHEN NEW.clearance = 'rejected' THEN 'staff-rejected' ELSE NULL END
    WHERE id = NEW.source_id;

  RETURN NEW;
END $$;
CREATE TRIGGER clearance_decision_apply AFTER INSERT ON media.clearance_decision
  FOR EACH ROW EXECUTE FUNCTION media.apply_clearance_decision();
-- An arbitrary slot mutation cannot install an uncleared or unrelated selection.
CREATE OR REPLACE FUNCTION media.slot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (OLD.target, OLD.context, OLD.role, OLD.policy)
      IS DISTINCT FROM (NEW.target, NEW.context, NEW.role, NEW.policy)
    OR (NEW.head IS DISTINCT FROM OLD.head AND NOT EXISTS (SELECT 1 FROM media.selection_revision r
      WHERE r.id = NEW.head AND (r.target, r.context, r.role) = (NEW.target, NEW.context, NEW.role)
        AND r.predecessor IS NOT DISTINCT FROM OLD.head))
    OR (NEW.delivery_head IS DISTINCT FROM OLD.delivery_head
      AND NEW.delivery_head IS DISTINCT FROM media.delivered_selection(OLD) AND NOT EXISTS (
      SELECT 1 FROM media.selection_revision r LEFT JOIN media.use u ON u.id = r.use_id
        LEFT JOIN media.representation p ON p.id = u.representation_id
      WHERE r.id = NEW.delivery_head AND r.id = NEW.head
        AND (r.use_id IS NULL OR media.delivery_clearance(p) = 'cleared'))) THEN
    RAISE EXCEPTION 'media selection slot changes only through a selection revision with cleared delivery' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
