-- migrate:up
-- A selected root remains trashed until this durable primary-tree walk has retired its descendants.
CREATE TABLE content.knowledge_lifecycle_restore (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  notebook_id uuid NOT NULL,
  root_document_id uuid NOT NULL,
  operation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  owner_account_id uuid NOT NULL,
  actor_client_id text,
  actor_scopes text[],
  actor_requested_by text,
  actor_authn_epoch integer,
  root_generation bigint NOT NULL CHECK (root_generation >= 0),
  restore_until timestamptz NOT NULL CHECK (isfinite(restore_until)),
  state text NOT NULL CHECK (state IN ('running', 'complete', 'expired', 'purged', 'superseded')),
  processed_documents bigint NOT NULL DEFAULT 0 CHECK (processed_documents >= 0),
  pending_placements bigint NOT NULL DEFAULT 1 CHECK (pending_placements >= 0),
  page_number bigint NOT NULL DEFAULT 0 CHECK (page_number >= 0),
  started_at timestamptz NOT NULL CHECK (isfinite(started_at)),
  completed_at timestamptz CHECK (completed_at IS NULL OR isfinite(completed_at)),
  PRIMARY KEY (route, root_document_id),
  UNIQUE (operation_id),
  UNIQUE (route, notebook_id, root_document_id),
  FOREIGN KEY (route, notebook_id, root_document_id)
    REFERENCES content.knowledge_document(route, notebook_id, document_id) ON DELETE CASCADE,
  CHECK (route = get_byte(uuid_send(notebook_id), 10) * 256 + get_byte(uuid_send(notebook_id), 11)),
  CHECK (route = get_byte(uuid_send(root_document_id), 10) * 256 + get_byte(uuid_send(root_document_id), 11)),
  CHECK (route = get_byte(uuid_send(owner_account_id), 10) * 256 + get_byte(uuid_send(owner_account_id), 11)),
  CHECK (
    (actor_client_id IS NULL AND actor_scopes IS NULL AND actor_requested_by IS NULL AND actor_authn_epoch IS NULL)
    OR
    (actor_client_id IS NOT NULL AND actor_scopes IS NOT NULL AND actor_authn_epoch IS NOT NULL)
  )
);
CREATE INDEX knowledge_lifecycle_restore_pending
  ON content.knowledge_lifecycle_restore(route, started_at, root_document_id)
  WHERE state = 'running';

-- Each row is a durable parent scan and its last examined child key. Newly found live children
-- become their own rows; independently trashed roots are not traversed by an ancestor restore.
-- Parent placements intentionally have no foreign key: purge may remove a pending parent, and the
-- worker must retain that scan row so an empty page closes its pending branch after restart.
CREATE TABLE content.knowledge_lifecycle_frontier (
  route integer NOT NULL,
  notebook_id uuid NOT NULL,
  root_document_id uuid NOT NULL,
  parent_placement_id uuid NOT NULL,
  after_position numeric(38, 0),
  after_placement_id uuid,
  exhausted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (route, notebook_id, root_document_id, parent_placement_id),
  FOREIGN KEY (route, notebook_id, root_document_id)
    REFERENCES content.knowledge_lifecycle_restore(route, notebook_id, root_document_id) ON DELETE CASCADE,
  CHECK ((after_position IS NULL) = (after_placement_id IS NULL))
);
CREATE INDEX knowledge_lifecycle_frontier_pending
  ON content.knowledge_lifecycle_frontier(route, notebook_id, root_document_id, parent_placement_id)
  WHERE NOT exhausted;

-- migrate:down
DROP TABLE content.knowledge_lifecycle_frontier;
DROP TABLE content.knowledge_lifecycle_restore;
