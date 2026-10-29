-- migrate:up
ALTER TABLE content.report
  ADD COLUMN outcome text,
  ADD COLUMN resolved_at timestamptz,
  ADD COLUMN resolved_by uuid,
  ADD COLUMN decision_id uuid,
  ADD CONSTRAINT report_outcome_shape CHECK (
    (outcome IS NULL AND resolved_at IS NULL AND resolved_by IS NULL AND decision_id IS NULL)
    OR (outcome IS NOT NULL AND outcome IN ('actioned', 'dismissed')
      AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL
      AND ((outcome = 'actioned' AND decision_id IS NOT NULL)
        OR (outcome = 'dismissed' AND decision_id IS NULL)))
  );

CREATE OR REPLACE FUNCTION content.guard_report() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.outcome IS NULL AND NEW.outcome IS NOT NULL
     AND (to_jsonb(NEW) - ARRAY['outcome', 'resolved_at', 'resolved_by', 'decision_id'])
       = (to_jsonb(OLD) - ARRAY['outcome', 'resolved_at', 'resolved_by', 'decision_id']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Report records and their resolved outcomes are immutable' USING ERRCODE = '23514';
END;
$$;

-- Takedowns of boards need the same immutable decision reference as other targets.
ALTER TABLE content.moderation_decision DROP CONSTRAINT moderation_decision_target_kind_check;
ALTER TABLE content.moderation_decision ADD CONSTRAINT moderation_decision_target_kind_check
  CHECK (target_kind IN ('board', 'thread', 'post'));

-- One durable cursor per takedown, advanced only after the page's resolutions and notices.
CREATE TABLE content.report_outcome_work (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  decision_id uuid NOT NULL,
  after_at timestamptz NOT NULL,
  after_id uuid NOT NULL,
  done boolean NOT NULL,
  PRIMARY KEY (route, decision_id),
  CHECK (route = get_byte(uuid_send(decision_id), 10) * 256 + get_byte(uuid_send(decision_id), 11))
);

-- A suppressed recipient stays suppressed on replay; a failed transaction retries.
CREATE TABLE content.report_outcome_delivery (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  recipient_id uuid NOT NULL,
  report_id uuid NOT NULL,
  PRIMARY KEY (route, recipient_id, report_id),
  CHECK (route = get_byte(uuid_send(recipient_id), 10) * 256 + get_byte(uuid_send(recipient_id), 11))
);

-- migrate:down
-- Forward only: resolutions and their immutable evidence survive rollback.
