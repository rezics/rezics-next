-- migrate:up
-- Reports have a key-derived route, independent of the reporter's partition.
CREATE TABLE content.report_reporter (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  reporter_account_id uuid NOT NULL,
  report_route integer NOT NULL CHECK (report_route BETWEEN 0 AND 65535),
  report_id uuid NOT NULL,
  PRIMARY KEY (route, reporter_account_id, report_id),
  CHECK (route = get_byte(uuid_send(reporter_account_id), 10) * 256 + get_byte(uuid_send(reporter_account_id), 11)),
  CHECK (report_route = get_byte(uuid_send(report_id), 10) * 256 + get_byte(uuid_send(report_id), 11))
);

INSERT INTO content.report_reporter (route, reporter_account_id, report_route, report_id)
SELECT get_byte(uuid_send(reporter_account_id), 10) * 256 + get_byte(uuid_send(reporter_account_id), 11),
       reporter_account_id, route, report_id
FROM content.report
WHERE reporter_account_id IS NOT NULL;

-- A monotone marker permits removing required evidence without admitting new
-- anonymous reports without evidence, or changing a retained report's reason.
ALTER TABLE content.report
  ADD COLUMN reporter_erased boolean NOT NULL DEFAULT false,
  DROP CONSTRAINT report_required_evidence,
  ADD CONSTRAINT report_required_evidence CHECK (
    reporter_erased OR reason NOT IN ('illegal', 'other') OR (evidence IS NOT NULL AND char_length(evidence) > 0)
  ),
  ADD CONSTRAINT report_reporter_erased_shape CHECK (
    NOT reporter_erased OR (reporter_account_id IS NULL AND evidence IS NULL)
  );

CREATE OR REPLACE FUNCTION content.guard_report() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.outcome IS NULL AND NEW.outcome IS NOT NULL
     AND (to_jsonb(NEW) - ARRAY['outcome', 'resolved_at', 'resolved_by', 'decision_id'])
       = (to_jsonb(OLD) - ARRAY['outcome', 'resolved_at', 'resolved_by', 'decision_id']) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NOT OLD.reporter_erased AND OLD.reporter_account_id IS NOT NULL
     AND NEW.reporter_erased AND NEW.reporter_account_id IS NULL AND NEW.evidence IS NULL
     AND (to_jsonb(NEW) - ARRAY['evidence', 'reporter_account_id', 'reporter_erased'])
       = (to_jsonb(OLD) - ARRAY['evidence', 'reporter_account_id', 'reporter_erased']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Report records and their resolved outcomes are immutable' USING ERRCODE = '23514';
END;
$$;

-- migrate:down
-- Forward only: erased reporter identity and evidence cannot be restored.
