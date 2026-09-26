-- Ranking generations for recommendation queries. Distinct from
-- access.realm_native_variant_recommendation, a Realm manager's reading hint.
-- Scores are sparse positive derived values under one declared population,
-- candidate grain, score policy and exact semantic/preference basis. Zero-score
-- fallback candidates come from eligible owner reads and are never stored.
CREATE TABLE access.ranking_generation (
    generation_id uuid PRIMARY KEY,
    family text NOT NULL DEFAULT 'ranking' CHECK (family = 'ranking'),
    population text NOT NULL CHECK (population IN ('public', 'realm', 'personal')),
    realm text CHECK (realm ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
    principal_id uuid REFERENCES access.principal(id),
    candidate_grain text NOT NULL CHECK (candidate_grain IN ('work', 'main-version')),
    score_policy text NOT NULL CHECK (score_policy ~ '^https://rezics[.]com/definition/[a-z0-9-]+-v[0-9]+$'),
    -- A semantic criterion is pinned as exact Context, definition-selection
    -- and preference-ordering revisions; the latter two are separate dependencies.
    context text CHECK (context ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
    context_revision text CHECK (context_revision ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
    semantic_selection_revision text
        CHECK (semantic_selection_revision ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
    preference_revision text CHECK (preference_revision ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
    partition_count smallint NOT NULL CHECK (partition_count BETWEEN 1 AND 256),
    FOREIGN KEY (generation_id, family) REFERENCES access.derived_generation(id, family) ON DELETE CASCADE,
    CONSTRAINT ranking_population_scope CHECK (
      (population = 'public' AND realm IS NULL AND principal_id IS NULL)
      OR (population = 'realm' AND realm IS NOT NULL AND principal_id IS NULL)
      OR (population = 'personal' AND realm IS NULL AND principal_id IS NOT NULL)),
    CONSTRAINT ranking_semantic_basis CHECK (
      (context IS NULL AND context_revision IS NULL AND semantic_selection_revision IS NULL)
      OR (context IS NOT NULL AND context_revision IS NOT NULL AND semantic_selection_revision IS NOT NULL)),
    CONSTRAINT ranking_preference_basis CHECK (preference_revision IS NULL OR context IS NOT NULL)
);
CREATE INDEX ranking_generation_principal ON access.ranking_generation (principal_id)
    WHERE principal_id IS NOT NULL;
CREATE INDEX ranking_generation_realm ON access.ranking_generation (realm) WHERE realm IS NOT NULL;

-- Partial totals replace one global exact counter; a batch updates only the
-- partitions its coalesced candidates touch.
CREATE TABLE access.ranking_partition (
    generation_id uuid NOT NULL REFERENCES access.ranking_generation(generation_id) ON DELETE CASCADE,
    partition smallint NOT NULL CHECK (partition BETWEEN 0 AND 255),
    candidate_count bigint NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
    signal_count bigint NOT NULL DEFAULT 0 CHECK (signal_count >= 0),
    score_total numeric NOT NULL DEFAULT 0 CHECK (score_total >= 0),
    PRIMARY KEY (generation_id, partition)
);

CREATE TABLE access.ranking_score (
    generation_id uuid NOT NULL,
    partition smallint NOT NULL,
    candidate text NOT NULL CHECK (candidate ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
    score numeric NOT NULL CHECK (score > 0),
    signal_count bigint NOT NULL CHECK (signal_count > 0),
    PRIMARY KEY (generation_id, candidate),
    FOREIGN KEY (generation_id, partition)
        REFERENCES access.ranking_partition(generation_id, partition) ON DELETE CASCADE
);
-- Declared order: score descending, then candidate IRI as deterministic tie-break.
CREATE INDEX ranking_score_order ON access.ranking_score (generation_id, score DESC, candidate);
CREATE INDEX ranking_score_partition ON access.ranking_score (generation_id, partition);

CREATE FUNCTION access.ranking_generation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'immutable ranking generation basis' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM access.derived_generation
                   WHERE id = NEW.generation_id AND state = 'building') THEN
        RAISE EXCEPTION 'ranking basis is declared while its generation builds' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER ranking_generation_guard
    BEFORE INSERT OR UPDATE ON access.ranking_generation
    FOR EACH ROW EXECUTE FUNCTION access.ranking_generation_guard();

CREATE FUNCTION access.ranking_partition_bound() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM access.ranking_generation
                   WHERE generation_id = NEW.generation_id AND NEW.partition < partition_count) THEN
        RAISE EXCEPTION 'ranking partition exceeds its declared count' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER ranking_partition_bound
    BEFORE INSERT OR UPDATE OF generation_id, partition ON access.ranking_partition
    FOR EACH ROW EXECUTE FUNCTION access.ranking_partition_bound();

CREATE TRIGGER ranking_partition_insert_guard AFTER INSERT ON access.ranking_partition
    REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION access.derived_rows_guard();
CREATE TRIGGER ranking_partition_update_guard AFTER UPDATE ON access.ranking_partition
    REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION access.derived_rows_guard();
CREATE TRIGGER ranking_partition_delete_guard AFTER DELETE ON access.ranking_partition
    REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION access.derived_rows_guard();
CREATE TRIGGER ranking_score_insert_guard AFTER INSERT ON access.ranking_score
    REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION access.derived_rows_guard();
CREATE TRIGGER ranking_score_update_guard AFTER UPDATE ON access.ranking_score
    REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION access.derived_rows_guard();
CREATE TRIGGER ranking_score_delete_guard AFTER DELETE ON access.ranking_score
    REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION access.derived_rows_guard();
