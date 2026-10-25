-- migrate:up
-- A report has its own receipt home, independent of the reported resource.
CREATE TABLE content.report (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  report_id uuid NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('board', 'thread', 'post')),
  target_id uuid NOT NULL,
  revision_id uuid,
  reason text NOT NULL CHECK (reason IN ('off_topic', 'inappropriate', 'spam', 'illegal', 'other')),
  evidence text CHECK (char_length(evidence) <= 4096),
  reporter_account_id uuid,
  created_at timestamptz NOT NULL,
  recorded_transaction_id uuid NOT NULL,
  recorded_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  PRIMARY KEY (route, report_id),
  CHECK (route = get_byte(uuid_send(report_id), 10) * 256 + get_byte(uuid_send(report_id), 11)),
  CHECK (reporter_account_id IS NULL OR reporter_account_id <> '00000000-0000-0000-0000-000000000000'::uuid),
  CHECK (octet_length(reason) + COALESCE(octet_length(evidence), 0) <= 2097152),
  CHECK (revision_id IS NULL OR target_kind <> 'board'),
  CONSTRAINT report_required_evidence CHECK (reason NOT IN ('illegal', 'other') OR
    (evidence IS NOT NULL AND char_length(evidence) > 0))
);

CREATE FUNCTION content.guard_report() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Report records are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER report_immutable BEFORE UPDATE OR DELETE ON content.report
FOR EACH ROW EXECUTE FUNCTION content.guard_report();

-- Disposable asynchronous references only. No evidence, reporter or target FK.
CREATE TABLE content.report_target (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  target_kind text NOT NULL CHECK (target_kind IN ('board', 'thread', 'post')),
  target_id uuid NOT NULL,
  report_route integer NOT NULL CHECK (report_route BETWEEN 0 AND 65535),
  report_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (route, target_kind, target_id, report_route, report_id),
  CHECK (route = get_byte(uuid_send(target_id), 10) * 256 + get_byte(uuid_send(target_id), 11)),
  CHECK (report_route = get_byte(uuid_send(report_id), 10) * 256 + get_byte(uuid_send(report_id), 11))
);
CREATE INDEX report_target_page_idx ON content.report_target
  (route, target_kind, target_id, created_at DESC, report_id DESC) INCLUDE (report_route);

-- migrate:down
-- Forward only: immutable governance records must survive rollback.
