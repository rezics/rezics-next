-- migrate:up
CREATE SCHEMA launcher;

CREATE TABLE launcher.package (
    id text COLLATE "C" PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('overlay-panel', 'minecraft-mod')),
    publisher text NOT NULL,
    title text NOT NULL,
    title_key text COLLATE "C" NOT NULL,
    summary text NOT NULL,
    subject_id uuid,
    live_count bigint NOT NULL CHECK (live_count >= 0)
);

CREATE INDEX package_kind_visible ON launcher.package (kind, id) WHERE live_count > 0;
CREATE INDEX package_title_visible ON launcher.package (kind, title_key, id) WHERE live_count > 0;

CREATE TABLE launcher.release (
    package_id text COLLATE "C" NOT NULL REFERENCES launcher.package (id),
    id text COLLATE "C" NOT NULL,
    version text NOT NULL,
    compatibility jsonb NOT NULL,
    artifact_url text NOT NULL,
    artifact_size bigint NOT NULL CHECK (artifact_size BETWEEN 1 AND 2147483648),
    artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
    requirements jsonb NOT NULL,
    published_at timestamp(3) with time zone NOT NULL,
    withdrawn_at timestamp with time zone,
    PRIMARY KEY (package_id, id),
    UNIQUE (package_id, version)
);

CREATE INDEX release_visible ON launcher.release (package_id, published_at DESC, id DESC)
    WHERE withdrawn_at IS NULL;

-- migrate:down
DROP TABLE launcher.release;
DROP TABLE launcher.package;
DROP SCHEMA launcher;
