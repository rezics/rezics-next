ALTER TABLE source.observation ADD COLUMN capture jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(capture) = 'object');

CREATE TABLE source.provider_rate_gate (
  provider text PRIMARY KEY,
  next_at timestamptz NOT NULL
);
