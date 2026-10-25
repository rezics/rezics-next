-- migrate:up
CREATE SCHEMA IF NOT EXISTS content;

CREATE TABLE content.media (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  media_id uuid NOT NULL,
  container_id uuid NOT NULL,
  uploader_id uuid NOT NULL,
  reservation_request_id text NOT NULL
    CHECK (char_length(reservation_request_id) BETWEEN 1 AND 255),
  purpose text NOT NULL CHECK (purpose IN ('post-image')),
  media_type text NOT NULL CHECK (media_type IN (
    'image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'
  )),
  byte_count bigint NOT NULL CHECK (byte_count BETWEEN 1 AND 20971520),
  declared_sha256 text CHECK (declared_sha256 ~ '^[0-9a-f]{64}$'),
  actual_byte_count bigint,
  sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('reserved', 'uploaded', 'available', 'rejected')),
  decision text CHECK (decision IS NULL OR char_length(decision) > 0),
  key text NOT NULL,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  transaction_id uuid NOT NULL,
  erased boolean NOT NULL DEFAULT false,
  collection_pending boolean NOT NULL DEFAULT false,
  PRIMARY KEY (route, media_id),
  UNIQUE (route, uploader_id, reservation_request_id),
  UNIQUE (route, key),
  CHECK (
    route = get_byte(uuid_send(media_id), 10) * 256 + get_byte(uuid_send(media_id), 11)
  ),
  CHECK (
    route = get_byte(uuid_send(container_id), 10) * 256 + get_byte(uuid_send(container_id), 11)
  ),
  CHECK (key = 'm/' || media_id::text || '/original'),
  CHECK (actual_byte_count IS NULL OR actual_byte_count > 0),
  CHECK (sha256 IS NULL OR declared_sha256 IS NULL OR sha256 = declared_sha256),
  CHECK (
    (state = 'reserved' AND actual_byte_count IS NULL AND sha256 IS NULL
      AND decision IS NULL AND claimed_at IS NULL)
    OR (state = 'uploaded' AND actual_byte_count = byte_count AND sha256 IS NOT NULL
      AND decision IS NULL AND claimed_at IS NULL)
    OR (state = 'available' AND actual_byte_count = byte_count AND sha256 IS NOT NULL
      AND decision IS NULL)
    OR (state = 'rejected' AND actual_byte_count = byte_count AND sha256 IS NOT NULL
      AND decision IS NOT NULL AND claimed_at IS NULL)
  ),
  CHECK (claimed_at IS NULL OR state = 'available'),
  CHECK (NOT collection_pending OR claimed_at IS NULL),
  CHECK (NOT (collection_pending AND erased))
);

CREATE INDEX media_collection_pending_idx
  ON content.media (route, created_at, media_id)
  WHERE collection_pending;

CREATE INDEX media_collection_eligible_idx
  ON content.media (route, created_at, media_id)
  WHERE claimed_at IS NULL AND NOT erased AND NOT collection_pending;

CREATE TABLE content.media_variant (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  media_id uuid NOT NULL,
  format text NOT NULL CHECK (format IN ('avif', 'webp')),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 2560),
  height integer NOT NULL CHECK (height > 0),
  media_type text NOT NULL CHECK (
    (format = 'avif' AND media_type = 'image/avif')
    OR (format = 'webp' AND media_type = 'image/webp')
  ),
  byte_count bigint NOT NULL CHECK (byte_count > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  key text NOT NULL,
  transaction_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (route, media_id, format, width),
  CONSTRAINT media_variant_width_ladder_check CHECK (
    width < 320 OR width IN (320, 640, 960, 1280, 1920, 2560)
  ),
  UNIQUE (route, key),
  FOREIGN KEY (route, media_id) REFERENCES content.media (route, media_id) ON DELETE CASCADE,
  CHECK (
    key = 'm/' || media_id::text || '/' || format || '-' || width::text
  )
);

-- migrate:down
-- Forward only: media identity and erasure metadata are durable.
