-- migrate:up
CREATE TABLE library.collection_pins (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  collection_ids uuid[] NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (route, account_id),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  CHECK (cardinality(collection_ids) <= 100),
  CHECK (cardinality(collection_ids) = 0 OR (array_ndims(collection_ids) = 1 AND array_lower(collection_ids, 1) = 1)),
  CHECK (array_position(collection_ids, NULL) IS NULL)
);

-- migrate:down
-- Forward only: private owner preferences retain their revision until account erasure.
