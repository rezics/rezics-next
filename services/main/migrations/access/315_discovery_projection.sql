-- Discovery is a separate meaning from recommendation signal sums. Every
-- generation pins one standing Context/population and a complete graph cut.
INSERT INTO access.derived_generation_family (family, max_retained, retain_for)
VALUES ('discovery', 3, interval '1 hour');

-- Transactional invalidation: sequence.nextval alone could be observed before
-- its source transaction commits. This row changes atomically with its source.
CREATE TABLE access.discovery_source_fence (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
INSERT INTO access.discovery_source_fence DEFAULT VALUES;
CREATE FUNCTION access.advance_discovery_source_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NULL; END IF;
    -- Protection reads may establish an empty baseline. Absence already has
    -- exactly that meaning; it must not invalidate a build doing the read.
    IF TG_OP = 'INSERT' AND (to_jsonb(NEW)->>'generation')::bigint = 0 THEN
        IF TG_TABLE_NAME = 'judgment_concept_hint' AND to_jsonb(NEW)->>'hint' IS NULL THEN RETURN NULL; END IF;
        IF TG_TABLE_NAME = 'judgment_aggregate'
            AND (to_jsonb(NEW)->>'fit_negative')::bigint = 0 AND (to_jsonb(NEW)->>'fit_positive')::bigint = 0
            AND (to_jsonb(NEW)->>'spoiler_none')::bigint = 0 AND (to_jsonb(NEW)->>'spoiler_minor')::bigint = 0
            AND (to_jsonb(NEW)->>'spoiler_major')::bigint = 0 THEN RETURN NULL; END IF;
    END IF;
    UPDATE access.discovery_source_fence SET revision = revision + 1 WHERE id;
    RETURN NULL;
END $$;
DO $$ DECLARE source text; BEGIN
    FOREACH source IN ARRAY ARRAY['principal', 'rating_aggregate_context', 'rating_aggregate_head',
        'governance_enforcement', 'judgment_aggregate', 'judgment_concept_hint', 'recovery_fence']
    LOOP
        EXECUTE format('CREATE TRIGGER discovery_source_changed AFTER INSERT OR UPDATE OR DELETE
            ON access.%I FOR EACH ROW EXECUTE FUNCTION access.advance_discovery_source_fence()', source);
        EXECUTE format('CREATE TRIGGER discovery_source_truncated AFTER TRUNCATE
            ON access.%I FOR EACH STATEMENT EXECUTE FUNCTION access.advance_discovery_source_fence()', source);
    END LOOP;
END $$;

CREATE TABLE access.discovery_generation (
    generation_id uuid PRIMARY KEY,
    family text NOT NULL DEFAULT 'discovery' CHECK (family = 'discovery'),
    scope text NOT NULL CHECK (scope IN ('global', 'realm', 'mine')),
    realm text,
    principal_id uuid REFERENCES access.principal(id),
    context text,
    source_epoch text NOT NULL,
    source_sequence numeric(20, 0) NOT NULL CHECK (source_sequence >= 0),
    access_revision bigint NOT NULL CHECK (access_revision >= 0),
    recovery_generation text NOT NULL,
    checkpoint text NOT NULL DEFAULT '',
    complete boolean NOT NULL DEFAULT false,
    work_count bigint NOT NULL DEFAULT 0 CHECK (work_count >= 0),
    FOREIGN KEY (generation_id, family) REFERENCES access.derived_generation(id, family),
    CHECK ((scope = 'realm') = (realm IS NOT NULL)),
    CHECK ((scope = 'mine') = (principal_id IS NOT NULL)),
    CHECK (scope <> 'mine' OR context IS NOT NULL),
    CHECK (realm IS NULL OR realm ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
    CHECK (context IS NULL OR context ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$')
);

-- Materialize all admitted equality combinations, including the empty wildcard.
-- At most 4 types (wildcard + three semantic types) x 21 terms per Work.
-- A rare term must not require scanning a more general score/recency index.
CREATE TABLE access.discovery_entry (
    generation_id uuid NOT NULL REFERENCES access.discovery_generation(generation_id),
    work text NOT NULL CHECK (work ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
    work_type text COLLATE "C" NOT NULL,
    term text COLLATE "C" NOT NULL,
    recent_order numeric(22, 0) NOT NULL CHECK (recent_order >= 0),
    rating_count smallint NOT NULL CHECK (rating_count BETWEEN 0 AND 100),
    rating_sum smallint NOT NULL CHECK (rating_sum BETWEEN rating_count AND 10 * rating_count),
    -- With integer values and <=100 voters, unequal means differ by >=1/10000.
    -- Twelve decimal places preserve their exact rational ordering.
    rating_order numeric(24, 12) GENERATED ALWAYS AS
        (CASE WHEN rating_count > 0 THEN -rating_sum::numeric / rating_count ELSE 0 END) STORED,
    payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 8192),
    PRIMARY KEY (generation_id, work, work_type, term)
);
CREATE INDEX discovery_recent_seek ON access.discovery_entry
    (generation_id, work_type, term, recent_order, work COLLATE "C");
CREATE INDEX discovery_rating_seek ON access.discovery_entry
    (generation_id, work_type, term, rating_order, work COLLATE "C") WHERE rating_count > 0;

CREATE TRIGGER discovery_entry_insert_guard AFTER INSERT ON access.discovery_entry
    REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION access.derived_rows_guard();
CREATE TRIGGER discovery_entry_update_guard AFTER UPDATE ON access.discovery_entry
    REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION access.derived_rows_guard();
CREATE TRIGGER discovery_entry_delete_guard AFTER DELETE ON access.discovery_entry
    REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION access.derived_rows_guard();

CREATE FUNCTION access.discovery_generation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM access.derived_generation
        WHERE id = NEW.generation_id AND family = 'discovery' AND state = 'building') THEN
        RAISE EXCEPTION 'discovery changes only while building' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND ((NEW.generation_id, NEW.family, NEW.scope, NEW.realm, NEW.principal_id,
        NEW.context, NEW.source_epoch, NEW.source_sequence, NEW.access_revision, NEW.recovery_generation)
        IS DISTINCT FROM (OLD.generation_id, OLD.family, OLD.scope, OLD.realm, OLD.principal_id,
        OLD.context, OLD.source_epoch, OLD.source_sequence, OLD.access_revision, OLD.recovery_generation)
        OR NEW.checkpoint < OLD.checkpoint OR (OLD.complete AND NOT NEW.complete)) THEN
        RAISE EXCEPTION 'discovery basis is immutable and checkpoint advances' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER discovery_generation_guard BEFORE INSERT OR UPDATE ON access.discovery_generation
    FOR EACH ROW EXECUTE FUNCTION access.discovery_generation_guard();
