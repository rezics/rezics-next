-- migrate:up
ALTER TABLE community.space_revision ADD COLUMN address text;

CREATE TABLE community.space_address_claim (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  normalized_address text COLLATE "C" NOT NULL CHECK (normalized_address ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  space_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'active', 'reserved')),
  expires_at timestamptz,
  reserved_until timestamptz,
  reservation_id uuid,
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, normalized_address),
  CHECK (route = get_byte(sha256(convert_to(normalized_address, 'UTF8')), 0) * 256
               + get_byte(sha256(convert_to(normalized_address, 'UTF8')), 1)),
  CHECK ((state = 'pending' AND expires_at IS NOT NULL AND reserved_until IS NULL)
      OR (state = 'active' AND expires_at IS NULL AND reserved_until IS NULL)
      OR (state = 'reserved' AND expires_at IS NULL AND reserved_until IS NOT NULL))
);

-- migrate:down
-- Forward only: published Space addresses and their reservations are durable identity.
