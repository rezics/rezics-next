-- migrate:up
CREATE TABLE library.shelf_type_value (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  type_id uuid NOT NULL,
  full_type text NOT NULL,
  byte_length bigint NOT NULL,
  json_byte_length bigint NOT NULL,
  CONSTRAINT shelf_type_value_pkey PRIMARY KEY (route, account_id, type_id),
  CONSTRAINT shelf_type_value_route_check CHECK (route BETWEEN 0 AND 65535),
  CONSTRAINT shelf_type_value_account_route_check CHECK (
    route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)
  ),
  CONSTRAINT shelf_type_value_type_id_route_check CHECK (
    route = get_byte(uuid_send(type_id), 10) * 256 + get_byte(uuid_send(type_id), 11)
  ),
  CONSTRAINT shelf_type_value_type_id_non_nil_check CHECK (
    type_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  CONSTRAINT shelf_type_value_byte_length_check CHECK (
    byte_length >= 0 AND byte_length = octet_length(full_type)
  ),
  CONSTRAINT shelf_type_value_json_byte_length_check CHECK (
    json_byte_length >= 0 AND json_byte_length = octet_length(to_json(full_type)::text)
  )
);

CREATE TABLE library.shelf_type_root (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  digest bytea NOT NULL,
  primary_type_id uuid NOT NULL,
  root_node_id uuid NOT NULL,
  CONSTRAINT shelf_type_root_pkey PRIMARY KEY (route, account_id, digest),
  CONSTRAINT shelf_type_root_owner_node_key UNIQUE (route, account_id, root_node_id),
  CONSTRAINT shelf_type_root_route_check CHECK (route BETWEEN 0 AND 65535),
  CONSTRAINT shelf_type_root_account_route_check CHECK (
    route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)
  ),
  CONSTRAINT shelf_type_root_digest_length_check CHECK (octet_length(digest) = 32),
  CONSTRAINT shelf_type_root_primary_type_id_route_check CHECK (
    route = get_byte(uuid_send(primary_type_id), 10) * 256 + get_byte(uuid_send(primary_type_id), 11)
  ),
  CONSTRAINT shelf_type_root_primary_type_id_non_nil_check CHECK (
    primary_type_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  CONSTRAINT shelf_type_root_node_id_route_check CHECK (
    route = get_byte(uuid_send(root_node_id), 10) * 256 + get_byte(uuid_send(root_node_id), 11)
  ),
  CONSTRAINT shelf_type_root_node_id_non_nil_check CHECK (
    root_node_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  CONSTRAINT shelf_type_root_primary_type_id_fkey
    FOREIGN KEY (route, account_id, primary_type_id)
    REFERENCES library.shelf_type_value (route, account_id, type_id)
);

CREATE TABLE library.shelf_type_node (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  node_id uuid NOT NULL,
  parent_id uuid NOT NULL,
  chunk bytea NOT NULL,
  terminal_type_id uuid,
  CONSTRAINT shelf_type_node_pkey PRIMARY KEY (route, account_id, node_id),
  CONSTRAINT shelf_type_node_parent_chunk_key UNIQUE (route, account_id, parent_id, chunk),
  CONSTRAINT shelf_type_node_route_check CHECK (route BETWEEN 0 AND 65535),
  CONSTRAINT shelf_type_node_account_route_check CHECK (
    route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)
  ),
  CONSTRAINT shelf_type_node_node_id_route_check CHECK (
    route = get_byte(uuid_send(node_id), 10) * 256 + get_byte(uuid_send(node_id), 11)
  ),
  CONSTRAINT shelf_type_node_node_id_non_nil_check CHECK (
    node_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  CONSTRAINT shelf_type_node_parent_id_route_check CHECK (
    route = get_byte(uuid_send(parent_id), 10) * 256 + get_byte(uuid_send(parent_id), 11)
  ),
  CONSTRAINT shelf_type_node_parent_id_non_nil_check CHECK (
    parent_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  CONSTRAINT shelf_type_node_not_self_parent_check CHECK (node_id <> parent_id),
  CONSTRAINT shelf_type_node_chunk_length_check CHECK (octet_length(chunk) BETWEEN 1 AND 256),
  CONSTRAINT shelf_type_node_terminal_type_id_route_check CHECK (
    terminal_type_id IS NULL OR
    route = get_byte(uuid_send(terminal_type_id), 10) * 256 + get_byte(uuid_send(terminal_type_id), 11)
  ),
  CONSTRAINT shelf_type_node_terminal_type_id_non_nil_check CHECK (
    terminal_type_id IS NULL OR terminal_type_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  CONSTRAINT shelf_type_node_terminal_type_id_fkey
    FOREIGN KEY (route, account_id, terminal_type_id)
    REFERENCES library.shelf_type_value (route, account_id, type_id)
);

CREATE UNIQUE INDEX shelf_type_node_terminal_type
  ON library.shelf_type_node (route, account_id, terminal_type_id)
  WHERE terminal_type_id IS NOT NULL;

CREATE TABLE library.shelf_type_reservation (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  full_type text NOT NULL,
  digest bytea NOT NULL,
  candidate_type_id uuid NOT NULL,
  node_id uuid NOT NULL,
  byte_offset bigint NOT NULL,
  fence_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  CONSTRAINT shelf_type_reservation_pkey PRIMARY KEY (route, account_id, reservation_id),
  CONSTRAINT shelf_type_reservation_route_check CHECK (route BETWEEN 0 AND 65535),
  CONSTRAINT shelf_type_reservation_account_route_check CHECK (
    route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)
  ),
  CONSTRAINT shelf_type_reservation_id_route_check CHECK (
    route = get_byte(uuid_send(reservation_id), 10) * 256 + get_byte(uuid_send(reservation_id), 11)
  ),
  CONSTRAINT shelf_type_reservation_id_non_nil_check CHECK (
    reservation_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  CONSTRAINT shelf_type_reservation_digest_length_check CHECK (octet_length(digest) = 32),
  CONSTRAINT shelf_type_reservation_candidate_type_id_route_check CHECK (
    route = get_byte(uuid_send(candidate_type_id), 10) * 256 + get_byte(uuid_send(candidate_type_id), 11)
  ),
  CONSTRAINT shelf_type_reservation_candidate_type_id_non_nil_check CHECK (
    candidate_type_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  CONSTRAINT shelf_type_reservation_node_id_route_check CHECK (
    route = get_byte(uuid_send(node_id), 10) * 256 + get_byte(uuid_send(node_id), 11)
  ),
  CONSTRAINT shelf_type_reservation_node_id_non_nil_check CHECK (
    node_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  CONSTRAINT shelf_type_reservation_byte_offset_check CHECK (
    byte_offset >= 0 AND byte_offset <= octet_length(full_type)
  ),
  CONSTRAINT shelf_type_reservation_fence_id_route_check CHECK (
    route = get_byte(uuid_send(fence_id), 10) * 256 + get_byte(uuid_send(fence_id), 11)
  ),
  CONSTRAINT shelf_type_reservation_fence_id_non_nil_check CHECK (
    fence_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  CONSTRAINT shelf_type_reservation_generation_id_route_check CHECK (
    route = get_byte(uuid_send(generation_id), 10) * 256 + get_byte(uuid_send(generation_id), 11)
  ),
  CONSTRAINT shelf_type_reservation_generation_id_non_nil_check CHECK (
    generation_id <> '00000000-0000-0000-0000-000000000000'::uuid
  )
);

COMMENT ON TABLE library.shelf_type_value IS
  'Exact type identities are scoped by route and account_id and retained at zero use until explicit account erasure.';
COMMENT ON TABLE library.shelf_type_root IS
  'Digest roots are scoped by route and account_id and retained until explicit account erasure.';
COMMENT ON TABLE library.shelf_type_node IS
  'Radix nodes and terminals are scoped by route and account_id and retained until explicit account erasure.';
COMMENT ON TABLE library.shelf_type_reservation IS
  'Staging reservations are scoped by route and account_id.';

-- migrate:down
-- Forward only: published type identities, roots and trie terminals must be retained.
