-- Fixed-Realm site configuration (SUB07). Rezics Pro is one ordinary operated
-- Realm served through such a site; other Realms can use the same kind. The
-- site binds one host to one Realm boundary for SSR, APIs, Search, downloads,
-- shared links and caches. There is deliberately no fallback column: an empty
-- or inaccessible local result never becomes general content. The Realm's
-- semantic identity and publication selections stay graph-owned; this owner
-- holds only installation-provisioned site configuration and its revisions.
CREATE SCHEMA site;

CREATE TABLE site.definition (
    id uuid PRIMARY KEY,
    host text NOT NULL UNIQUE
        CHECK (host ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'),
    head_revision bigint NOT NULL CHECK (head_revision >= 1),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Query cursors bind (site_id, revision); a later revision makes older cursors
-- restart explicitly rather than continue across a changed boundary.
CREATE TABLE site.definition_revision (
    site_id uuid NOT NULL REFERENCES site.definition(id),
    revision bigint NOT NULL CHECK (revision >= 1),
    kind text NOT NULL CHECK (kind = 'fixed-realm'),
    realm text NOT NULL CHECK (realm ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
    lifecycle text NOT NULL CHECK (lifecycle IN ('active', 'retired')),
    -- Frontend presentation profile only; publication follows the Realm's own
    -- selections and governance its own authority, never this key.
    presentation_profile text NOT NULL CHECK (presentation_profile ~ '^[a-z][a-z0-9-]{0,62}$'),
    -- Optional commerce benefit a reader needs for gated site content.
    required_benefit text CHECK (required_benefit ~ '^[a-z][a-z0-9.-]{0,126}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (site_id, revision)
);
CREATE INDEX definition_revision_realm ON site.definition_revision (realm, site_id, revision);
ALTER TABLE site.definition ADD CONSTRAINT definition_head_revision_fk
    FOREIGN KEY (id, head_revision) REFERENCES site.definition_revision(site_id, revision)
    DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION site.guard_definition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'site definition cannot be deleted' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.head_revision <> 1 THEN
            RAISE EXCEPTION 'site definition starts at revision one' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF (NEW.id, NEW.host, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.host, OLD.created_at)
        OR NEW.head_revision <> OLD.head_revision + 1 THEN
        RAISE EXCEPTION 'site identity or revision changed illegally' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER definition_guard BEFORE INSERT OR UPDATE OR DELETE ON site.definition
    FOR EACH ROW EXECUTE FUNCTION site.guard_definition();

-- A site keeps one Realm for its lifetime: a different Realm needs a new site,
-- so no revision can silently move an existing host's boundary.
CREATE FUNCTION site.guard_definition_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'immutable site definition revision' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM site.definition_revision r
        WHERE r.site_id = NEW.site_id AND (r.realm <> NEW.realm OR r.lifecycle = 'retired')) THEN
        RAISE EXCEPTION 'site Realm is fixed and retirement is final' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER definition_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON site.definition_revision
    FOR EACH ROW EXECUTE FUNCTION site.guard_definition_revision();
