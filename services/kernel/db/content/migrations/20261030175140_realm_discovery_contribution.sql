-- migrate:up
CREATE TABLE content.realm_discovery_operation (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  intent text NOT NULL CHECK (intent ~ '^[0-9a-f]{64}$'),
  generation bigint NOT NULL CHECK (generation > 0),
  target_kind text NOT NULL CHECK (target_kind IN ('board','thread','post')),
  effect text NOT NULL CHECK (effect IN ('retract','restore')),
  target_id uuid NOT NULL,
  native_version bigint NOT NULL CHECK (native_version > 0),
  source_version bigint NOT NULL CHECK (source_version >= 0),
  thread_id uuid,
  board_id uuid NOT NULL,
  realm_id uuid NOT NULL,
  space_id uuid NOT NULL,
  realm_epoch bigint NOT NULL CHECK (realm_epoch > 0),
  phase text NOT NULL DEFAULT 'prepared' CHECK (phase IN ('prepared','ready','applied','aborted')),
  fence_generation bigint,
  preparation_transaction_id uuid NOT NULL,
  outcome_transaction_id uuid,
  projected boolean NOT NULL DEFAULT false,
  PRIMARY KEY (route, intent, generation),
  CHECK (route = get_byte(uuid_send(target_id), 10) * 256 + get_byte(uuid_send(target_id), 11)),
  CHECK (phase <> 'ready' OR fence_generation IS NOT NULL),
  CHECK ((phase IN ('applied','aborted')) = (outcome_transaction_id IS NOT NULL)),
  CHECK (NOT projected OR phase IN ('applied','aborted'))
);
CREATE INDEX realm_discovery_operation_recovery ON content.realm_discovery_operation
  (route, intent, generation) WHERE NOT projected AND phase IN ('applied','aborted');

-- migrate:down
