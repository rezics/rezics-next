-- migrate:up
CREATE TABLE content.realm_subject_scope_state (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  scope_kind text NOT NULL CHECK (scope_kind IN ('realm', 'space', 'realm-board-set')),
  scope_id uuid NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  PRIMARY KEY (route, scope_kind, scope_id)
);
CREATE TABLE content.realm_subject_scope_event (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  scope_kind text NOT NULL CHECK (scope_kind IN ('realm', 'space', 'realm-board-set')),
  scope_id uuid NOT NULL,
  source_partition integer NOT NULL CHECK (source_partition BETWEEN 0 AND 4095),
  source_epoch integer NOT NULL CHECK (source_epoch > 0),
  source_position bigint NOT NULL CHECK (source_position > 0),
  event_id uuid NOT NULL,
  PRIMARY KEY (route, scope_kind, scope_id, source_partition, source_epoch, source_position, event_id)
);
CREATE TABLE content.realm_subject_sweep_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  generation uuid NOT NULL DEFAULT gen_random_uuid(),
  next_route integer NOT NULL DEFAULT 0 CHECK (next_route BETWEEN 0 AND 65536),
  complete boolean NOT NULL DEFAULT false,
  CHECK ((complete AND next_route = 65536) OR (NOT complete AND next_route < 65536))
);
INSERT INTO content.realm_subject_sweep_state(singleton) VALUES (true);

CREATE INDEX realm_subject_candidate_original ON content.realm_subject_candidate
  (original_id, route, realm_id, thread_id);
CREATE TABLE content.realm_subject_identity_work (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  source_partition integer NOT NULL CHECK (source_partition BETWEEN 0 AND 4095),
  source_epoch integer NOT NULL CHECK (source_epoch > 0),
  source_position bigint NOT NULL CHECK (source_position > 0),
  event_id uuid NOT NULL,
  original_id uuid NOT NULL,
  after_route integer NOT NULL DEFAULT -1 CHECK (after_route BETWEEN -1 AND 65535),
  after_realm_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  after_thread_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  complete boolean NOT NULL DEFAULT false,
  PRIMARY KEY (route, source_partition, source_epoch, source_position, event_id)
);
CREATE INDEX realm_subject_identity_work_pending ON content.realm_subject_identity_work
  (route, source_partition, source_epoch, source_position, event_id) WHERE NOT complete;

-- Readiness checks one indexed key for unfinished native effect delivery.
CREATE INDEX history_event_consumer_open_consumer ON core.history_event_consumer (consumer) WHERE state = 'open';
-- migrate:down
-- Forward only: captured cuts and monotone scope/identity work must survive restart.
