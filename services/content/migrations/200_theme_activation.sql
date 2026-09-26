-- Content keeps the monotone owner-side activation history used to detect a
-- missing or rolled-back graph head. The graph receipt remains the command
-- receipt; these rows are a recoverable owner projection, not a second receipt.
CREATE TABLE content.theme_activation (
  theme_id uuid NOT NULL,
  revision_id uuid PRIMARY KEY,
  predecessor_id uuid,
  approval_generation bigint NOT NULL CHECK (approval_generation > 0),
  owner text NOT NULL CHECK (owner ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
  dependency_digest text NOT NULL CHECK (dependency_digest ~ '^[0-9a-f]{64}$'),
  capability_digest text NOT NULL CHECK (capability_digest ~ '^[0-9a-f]{64}$'),
  capabilities jsonb NOT NULL CHECK (jsonb_typeof(capabilities) = 'object'
    AND octet_length(capabilities::text) <= 4096),
  origin text NOT NULL CHECK (length(origin) BETWEEN 9 AND 512 AND origin ~ '^https://[^[:space:]]+$'),
  runtime text NOT NULL CHECK (runtime = 'worker-isolated-v1'),
  approval_id uuid NOT NULL UNIQUE,
  approved_by text NOT NULL CHECK (approved_by ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
  approved_at timestamptz NOT NULL,
  approval_expires_at timestamptz NOT NULL CHECK (approval_expires_at > approved_at),
  graph_receipt text NOT NULL UNIQUE CHECK (graph_receipt ~ '^urn:rezics:receipt:[0-9a-f]{64}$'),
  graph_data_epoch uuid NOT NULL,
  graph_sequence numeric(38,0) NOT NULL CHECK (graph_sequence > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (theme_id, approval_generation),
  UNIQUE (theme_id, revision_id),
  FOREIGN KEY (theme_id, predecessor_id) REFERENCES content.theme_activation(theme_id, revision_id),
  CHECK ((approval_generation = 1) = (predecessor_id IS NULL))
);
CREATE INDEX theme_activation_history_idx ON content.theme_activation(theme_id, approval_generation DESC);

CREATE TABLE content.theme_activation_head (
  theme_id uuid PRIMARY KEY,
  revision_id uuid NOT NULL,
  approval_generation bigint NOT NULL CHECK (approval_generation > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (theme_id, revision_id) REFERENCES content.theme_activation(theme_id, revision_id)
);

CREATE FUNCTION content.guard_theme_activation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'theme activation history is immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER theme_activation_immutable BEFORE UPDATE OR DELETE ON content.theme_activation
  FOR EACH ROW EXECUTE FUNCTION content.guard_theme_activation_immutable();

CREATE FUNCTION content.guard_theme_activation_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior content.theme_activation%ROWTYPE; new_revision content.theme_activation%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'theme activation head cannot be deleted' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO new_revision FROM content.theme_activation
    WHERE theme_id = NEW.theme_id AND revision_id = NEW.revision_id;
  IF NOT FOUND OR new_revision.approval_generation <> NEW.approval_generation THEN
    RAISE EXCEPTION 'theme activation head does not name an exact revision' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.approval_generation <> 1 OR new_revision.predecessor_id IS NOT NULL THEN
      RAISE EXCEPTION 'first theme activation must start at generation one' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO prior FROM content.theme_activation
      WHERE theme_id = OLD.theme_id AND revision_id = OLD.revision_id;
    IF NEW.theme_id <> OLD.theme_id OR NEW.approval_generation <> OLD.approval_generation + 1
      OR new_revision.predecessor_id <> OLD.revision_id OR prior.revision_id IS NULL THEN
      RAISE EXCEPTION 'theme activation head must advance to its successor' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER theme_activation_head_guard BEFORE INSERT OR UPDATE OR DELETE ON content.theme_activation_head
  FOR EACH ROW EXECUTE FUNCTION content.guard_theme_activation_head();
