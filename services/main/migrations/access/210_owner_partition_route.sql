-- Current placement is a routing fence, not a second relocation history. The
-- immutable move and its verified evidence live in relay.owner_relocation.
CREATE TABLE access.owner_partition_route (
    owner text NOT NULL CHECK (owner IN ('graph', 'content', 'object')),
    dataset_id text NOT NULL CHECK (length(dataset_id) BETWEEN 1 AND 300),
    location text NOT NULL CHECK (length(location) BETWEEN 1 AND 500),
    routing_epoch text NOT NULL CHECK (routing_epoch <> ''),
    lease_epoch bigint NOT NULL DEFAULT 1 CHECK (lease_epoch >= 1),
    relocation_id uuid,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (owner, dataset_id)
);

-- Every lease check and cutover reads this primary key. The move increments
-- the lease epoch in the same row CAS that changes the route.
