-- migrate:up
CREATE FUNCTION semantic.subject_page_valid_witnesses(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT jsonb_typeof(value) = 'array' AND jsonb_array_length(value) <= 8
    AND (SELECT count(*) = count(DISTINCT (entry->>'kind', entry->>'key'))
         AND coalesce(bool_and(coalesce(entry->>'kind' IN ('fact','cover','relation')
             AND jsonb_typeof(entry->'key') = 'string', false)), true)
         FROM jsonb_array_elements(value) entry)
$$;
CREATE TABLE semantic.subject_page_publication (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535), subject_id uuid NOT NULL,
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  readiness text NOT NULL DEFAULT 'cold' CHECK (readiness IN ('cold','repairing','ready')),
  completed_position bigint NOT NULL DEFAULT 0, change_position bigint NOT NULL DEFAULT 0,
  public_effective_at timestamptz, evidence text NOT NULL DEFAULT 'missing' CHECK (evidence IN ('known','missing')),
  witnesses jsonb NOT NULL DEFAULT '[]' CHECK (semantic.subject_page_valid_witnesses(witnesses)),
  PRIMARY KEY (route, subject_id), CHECK ((evidence = 'known') = (public_effective_at IS NOT NULL))
);
CREATE TABLE semantic.subject_page_component (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535), subject_id uuid NOT NULL,
  component_kind text NOT NULL CHECK (component_kind IN ('label','fact','cover','relation')), component_key text NOT NULL,
  generation bigint NOT NULL, shown boolean NOT NULL, digest text, effective_at timestamptz,
  evidence text NOT NULL CHECK (evidence IN ('known','missing')), last_change_position bigint NOT NULL,
  source_version bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (route, subject_id, component_kind, component_key),
  CHECK (shown = (digest IS NOT NULL)), CHECK ((evidence = 'known') = (effective_at IS NOT NULL))
);
CREATE TABLE semantic.subject_page_dependency (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535), subject_id uuid NOT NULL, owner_kind text NOT NULL CHECK (owner_kind IN ('subject','source-fence')),
  owner_route integer NOT NULL CHECK (owner_route BETWEEN 0 AND 65535), owner_key text NOT NULL, component_key text NOT NULL,
  source_version bigint NOT NULL, present boolean NOT NULL, event_id text NOT NULL,
  PRIMARY KEY (route, subject_id, owner_kind, owner_route, owner_key, component_key)
);
CREATE INDEX subject_page_dependency_component ON semantic.subject_page_dependency (route, subject_id, component_key, owner_kind, owner_route, owner_key) WHERE present;
CREATE TABLE semantic.subject_page_owner_dependency (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535), owner_kind text NOT NULL CHECK (owner_kind IN ('subject','source-fence')),
  owner_key text NOT NULL, source_route integer NOT NULL CHECK (source_route BETWEEN 0 AND 65535), source_subject_id uuid NOT NULL,
  component_key text NOT NULL, source_version bigint NOT NULL, present boolean NOT NULL, event_id text NOT NULL,
  effective_at timestamptz, evidence text NOT NULL CHECK (evidence IN ('known','missing')),
  PRIMARY KEY (route, owner_kind, owner_key, source_route, source_subject_id, component_key),
  CHECK ((evidence = 'known') = (effective_at IS NOT NULL))
);
CREATE INDEX subject_page_owner_dependency_present ON semantic.subject_page_owner_dependency
(route, owner_kind, owner_key, source_route, source_subject_id, component_key) WHERE present;
CREATE TABLE semantic.subject_page_change (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535), subject_id uuid NOT NULL, position bigint NOT NULL, change_id text NOT NULL,
  component_kind text CHECK (component_kind IN ('label','fact','cover','relation')), component_key text, before_state jsonb NOT NULL, after_state jsonb NOT NULL,
  effective_at timestamptz, evidence text NOT NULL CHECK (evidence IN ('known','missing')),
  PRIMARY KEY (route, subject_id, position), UNIQUE (route, subject_id, change_id),
  CHECK ((component_kind IS NULL) = (component_key IS NULL)), CHECK ((evidence = 'known') = (effective_at IS NOT NULL))
);
CREATE TRIGGER subject_page_change_immutable BEFORE UPDATE OR DELETE ON semantic.subject_page_change
FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TABLE semantic.subject_page_repair (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535), subject_id uuid NOT NULL, version bigint NOT NULL DEFAULT 1,
  generation bigint NOT NULL, phase text NOT NULL DEFAULT 'descriptive' CHECK (phase IN ('bootstrap','descriptive','relations','evidence','replay','done')),
  source_key text[] NOT NULL DEFAULT '{}', high_water bigint NOT NULL DEFAULT 0, replay_position bigint NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','done')), available_at timestamptz NOT NULL DEFAULT now(),
  worker text, lease_until timestamptz, dirty boolean NOT NULL DEFAULT false,
  PRIMARY KEY (route, subject_id)
);
CREATE INDEX subject_page_repair_runnable ON semantic.subject_page_repair (route, state, available_at, subject_id);
CREATE TABLE semantic.subject_page_fanout (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535), owner_kind text NOT NULL CHECK (owner_kind IN ('subject','source-fence')), owner_key text NOT NULL, change_id text NOT NULL,
  effective_at timestamptz, evidence text NOT NULL CHECK (evidence IN ('known','missing')),
  version bigint NOT NULL DEFAULT 1, source_key text[] NOT NULL DEFAULT '{}',
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','done')), available_at timestamptz NOT NULL DEFAULT now(),
  worker text, lease_until timestamptz,
  PRIMARY KEY (route, owner_kind, owner_key, change_id), CHECK ((evidence = 'known') = (effective_at IS NOT NULL))
);
CREATE INDEX subject_page_fanout_runnable ON semantic.subject_page_fanout (route, state, available_at, owner_kind, owner_key, change_id);
CREATE TABLE semantic.subject_page_owner (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535), owner_kind text NOT NULL CHECK (owner_kind IN ('subject','source-fence')), owner_key text NOT NULL, change_id text NOT NULL,
  effective_at timestamptz, evidence text NOT NULL CHECK (evidence IN ('known','missing')),
  PRIMARY KEY (route, owner_kind, owner_key), CHECK ((evidence = 'known') = (effective_at IS NOT NULL))
);
CREATE TABLE semantic.subject_page_delivery (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535), subject_id uuid NOT NULL, owner_kind text NOT NULL CHECK (owner_kind IN ('subject','source-fence')),
  owner_route integer NOT NULL CHECK (owner_route BETWEEN 0 AND 65535), owner_key text NOT NULL,
  change_id text NOT NULL, event_id text NOT NULL, effective_at timestamptz, evidence text NOT NULL CHECK (evidence IN ('known','missing')),
  PRIMARY KEY (route, subject_id, owner_kind, owner_route, owner_key, change_id, event_id),
  CHECK ((evidence = 'known') = (effective_at IS NOT NULL))
);
CREATE TABLE semantic.subject_page_bootstrap (
  partition_no integer PRIMARY KEY CHECK (partition_no BETWEEN 0 AND 4095), version bigint NOT NULL DEFAULT 1,
  source_key jsonb, state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','done')),
  available_at timestamptz NOT NULL DEFAULT now(), worker text, lease_until timestamptz
);
INSERT INTO semantic.subject_page_bootstrap(partition_no) SELECT generate_series(0,4095);

CREATE TABLE semantic.subject_page_source (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535), subject_id uuid NOT NULL, candidate_id uuid NOT NULL,
  owner_route integer NOT NULL CHECK (owner_route BETWEEN 0 AND 65535), owner_key text NOT NULL,
  PRIMARY KEY (route, subject_id, candidate_id)
);

CREATE TABLE semantic.subject_page_continuation (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535), subject_id uuid NOT NULL, kind text NOT NULL, change_id text NOT NULL,
  effective_at timestamptz, evidence text NOT NULL CHECK (evidence IN ('known','missing')),
  PRIMARY KEY (route,subject_id,kind), CHECK ((evidence = 'known') = (effective_at IS NOT NULL))
);
ALTER TABLE semantic.merge_member ADD COLUMN publication_origin jsonb;

-- migrate:down
ALTER TABLE semantic.merge_member DROP COLUMN publication_origin;
DROP TABLE semantic.subject_page_continuation;
DROP TABLE semantic.subject_page_source;
DROP TABLE semantic.subject_page_bootstrap, semantic.subject_page_delivery, semantic.subject_page_owner,
semantic.subject_page_fanout, semantic.subject_page_repair, semantic.subject_page_change,
semantic.subject_page_owner_dependency, semantic.subject_page_dependency, semantic.subject_page_component,
semantic.subject_page_publication;
DROP FUNCTION semantic.subject_page_valid_witnesses(jsonb);
