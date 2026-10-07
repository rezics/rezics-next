-- Supplemental coverage belongs to the exact unchanged immutable manifest.
CREATE TABLE structure.qualifier_root (
  manifest_digest text PRIMARY KEY CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  source_root text NOT NULL CHECK (source_root ~ '^sha256:[0-9a-f]{64}$'),
  source jsonb NOT NULL CHECK (jsonb_typeof(source) = 'object'),
  progress jsonb NOT NULL CHECK (jsonb_typeof(progress) = 'object'),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  batch_limit integer NOT NULL DEFAULT 256 CHECK (batch_limit BETWEEN 1 AND 256),
  complete boolean NOT NULL DEFAULT false
);
