-- migrate:up
ALTER TABLE content.report DROP CONSTRAINT report_target_kind_check;
ALTER TABLE content.report ADD CONSTRAINT report_target_kind_check CHECK (target_kind IN ('board','thread','post','subject'));
ALTER TABLE content.report_target DROP CONSTRAINT report_target_target_kind_check;
ALTER TABLE content.report_target ADD CONSTRAINT report_target_target_kind_check CHECK (target_kind IN ('board','thread','post','subject'));

ALTER TABLE content.report DROP CONSTRAINT report_check2;
ALTER TABLE content.report ADD CONSTRAINT report_check2 CHECK (revision_id IS NULL OR target_kind NOT IN ('board','subject'));
ALTER TABLE content.report DROP CONSTRAINT report_outcome_shape;
ALTER TABLE content.report ADD CONSTRAINT report_outcome_shape CHECK (
  (outcome IS NULL AND resolved_at IS NULL AND resolved_by IS NULL AND decision_id IS NULL)
  OR (outcome IS NOT NULL AND outcome IN ('actioned','dismissed') AND resolved_at IS NOT NULL
    AND ((outcome='actioned' AND ((target_kind='subject' AND decision_id IS NULL)
        OR (target_kind<>'subject' AND decision_id IS NOT NULL)))
      OR (outcome='dismissed' AND decision_id IS NULL AND resolved_by IS NOT NULL)))
);

-- Global catalogue candidates contain references only; the report remains authoritative.
CREATE TABLE content.catalogue_report_candidate (
  route integer NOT NULL CHECK (route = 0),
  report_route integer NOT NULL CHECK (report_route BETWEEN 0 AND 65535),
  report_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (route, report_id),
  CHECK (report_route = get_byte(uuid_send(report_id),10)*256 + get_byte(uuid_send(report_id),11))
);
CREATE INDEX catalogue_report_candidate_page_idx ON content.catalogue_report_candidate
(route, created_at DESC, report_id DESC) INCLUDE (report_route, subject_id);

-- Latest observed visibility reduction repairs late report projections after restoration.
CREATE TABLE content.subject_report_action (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  subject_id uuid NOT NULL,
  security_revision bigint NOT NULL CHECK (security_revision > 0),
  action_id uuid NOT NULL,
  decided_at timestamptz NOT NULL,
  PRIMARY KEY (route, subject_id),
  CHECK (route = get_byte(uuid_send(subject_id),10)*256 + get_byte(uuid_send(subject_id),11)),
  CHECK (route = get_byte(uuid_send(action_id),10)*256 + get_byte(uuid_send(action_id),11))
);

-- migrate:down
ALTER TABLE content.report DROP CONSTRAINT report_check2;
ALTER TABLE content.report ADD CONSTRAINT report_check2 CHECK (revision_id IS NULL OR target_kind <> 'board');
ALTER TABLE content.report DROP CONSTRAINT report_outcome_shape;
ALTER TABLE content.report ADD CONSTRAINT report_outcome_shape CHECK (
  (outcome IS NULL AND resolved_at IS NULL AND resolved_by IS NULL AND decision_id IS NULL)
  OR (outcome IS NOT NULL AND outcome IN ('actioned','dismissed') AND resolved_at IS NOT NULL
    AND ((outcome='actioned' AND decision_id IS NOT NULL)
      OR (outcome='dismissed' AND decision_id IS NULL AND resolved_by IS NOT NULL)))
);
DROP TABLE content.subject_report_action;
DROP TABLE content.catalogue_report_candidate;
-- Subject reports must be retained; rollback requires an empty Subject population.
ALTER TABLE content.report DROP CONSTRAINT report_target_kind_check;
ALTER TABLE content.report ADD CONSTRAINT report_target_kind_check CHECK (target_kind IN ('board','thread','post'));
ALTER TABLE content.report_target DROP CONSTRAINT report_target_target_kind_check;
ALTER TABLE content.report_target ADD CONSTRAINT report_target_target_kind_check CHECK (target_kind IN ('board','thread','post'));
