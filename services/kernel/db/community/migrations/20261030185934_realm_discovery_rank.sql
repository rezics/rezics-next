-- migrate:up
-- One explicit routed derived-index home. Source homes remain independent authorities.
CREATE TABLE community.discovery_anchor (
  route integer PRIMARY KEY CHECK (route = 0),
  publication_epoch bigint NOT NULL DEFAULT 1 CHECK (publication_epoch > 0)
);
INSERT INTO community.discovery_anchor (route) VALUES (0);
CREATE TABLE community.discovery_realm (
  route integer NOT NULL CHECK (route = 0), realm_id uuid NOT NULL,
  realm_epoch text NOT NULL, applied_generation bigint NOT NULL CHECK (applied_generation >= 0),
  settled boolean NOT NULL DEFAULT false, cutoff date NOT NULL,
  popular bigint NOT NULL DEFAULT 0 CHECK (popular >= 0),
  trending bigint NOT NULL DEFAULT 0 CHECK (trending >= 0),
  PRIMARY KEY (route, realm_id)
);
CREATE INDEX discovery_popular ON community.discovery_realm (route, (-popular), realm_id) WHERE popular > 0;
CREATE INDEX discovery_trending ON community.discovery_realm (route, (-trending), realm_id) WHERE trending > 0;
CREATE TABLE community.discovery_board (
  route integer NOT NULL CHECK (route = 0), realm_id uuid NOT NULL, realm_epoch text NOT NULL,
  board_id uuid NOT NULL, source_version text NOT NULL,
  published boolean NOT NULL,
  PRIMARY KEY (route, realm_id, realm_epoch, board_id)
);
CREATE TABLE community.discovery_thread (
  route integer NOT NULL CHECK (route = 0), realm_id uuid NOT NULL, realm_epoch text NOT NULL,
  thread_id uuid NOT NULL, board_id uuid NOT NULL, space_id uuid NOT NULL, source_route integer NOT NULL,
  creation_day date NOT NULL, source_version text NOT NULL,
  contributing boolean NOT NULL,
  PRIMARY KEY (route, realm_id, realm_epoch, thread_id)
);
CREATE TABLE community.discovery_bucket (
  route integer NOT NULL CHECK (route = 0), realm_id uuid NOT NULL, realm_epoch text NOT NULL,
  board_id uuid NOT NULL, creation_day date NOT NULL, count bigint NOT NULL CHECK (count >= 0),
  PRIMARY KEY (route, realm_id, realm_epoch, board_id, creation_day)
);
CREATE TABLE community.discovery_day (
  route integer NOT NULL CHECK (route = 0), realm_id uuid NOT NULL, creation_day date NOT NULL,
  count bigint NOT NULL CHECK (count >= 0), PRIMARY KEY (route, realm_id, creation_day)
);
-- Every cleanup/rollover key is installed by its write, never discovered through a sweep.
CREATE TABLE community.discovery_due (
  route integer NOT NULL CHECK (route = 0), kind text NOT NULL CHECK (kind IN ('realm','bucket','thread','board')),
  realm_id uuid NOT NULL, realm_epoch text NOT NULL, key uuid NOT NULL, day date NOT NULL,
  due_at timestamptz NOT NULL CHECK (isfinite(due_at)),
  PRIMARY KEY (route, kind, realm_id, realm_epoch, key, day)
);
CREATE INDEX discovery_due_frontier ON community.discovery_due (route, due_at, kind, realm_id, realm_epoch, key, day);

-- migrate:down
-- Forward only: retain source frontiers across deployment rollbacks.
