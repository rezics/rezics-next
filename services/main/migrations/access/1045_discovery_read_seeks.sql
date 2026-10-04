-- Readers already load the immutable storage cut with their generation. Keep
-- that cut as parameters so every posting-list and membership probe shares the
-- same equality key, without per-probe metadata subqueries.
CREATE FUNCTION access.discovery_entries(uuid, bigint) RETURNS SETOF access.discovery_entry
LANGUAGE sql STABLE AS $$
    SELECT e.* FROM access.discovery_entry e
    WHERE e.generation_id=$1 AND e.entry_version<=$2
      AND (e.retired_version IS NULL OR e.retired_version>$2)
$$;
CREATE FUNCTION access.discovery_terms(uuid, bigint) RETURNS SETOF access.discovery_term_count
LANGUAGE sql STABLE AS $$
    SELECT t.* FROM access.discovery_term_count t
    WHERE t.generation_id=$1 AND t.entry_version<=$2
      AND (t.retired_version IS NULL OR t.retired_version>$2)
$$;
CREATE FUNCTION access.discovery_concepts(uuid, bigint) RETURNS SETOF access.discovery_concept_count
LANGUAGE sql STABLE AS $$
    SELECT c.* FROM access.discovery_concept_count c
    WHERE c.generation_id=$1 AND c.entry_version<=$2
      AND (c.retired_version IS NULL OR c.retired_version>$2)
$$;

-- Logical-id adapters remain available to SQL consumers. Resolve both fields
-- together once per invocation; production single-generation reads use the
-- parameter overloads above and do no metadata searches.
CREATE OR REPLACE FUNCTION access.discovery_entries(uuid) RETURNS SETOF access.discovery_entry
LANGUAGE sql STABLE AS $$
    SELECT d.generation_id,e.work,e.work_type,e.term,e.recent_order,e.rating_count,
        e.rating_sum,e.rating_order,e.payload,e.entry_version,e.retired_version
    FROM access.discovery_generation d CROSS JOIN LATERAL
        access.discovery_entries(coalesce(d.storage_generation,d.generation_id),d.storage_version) e
    WHERE d.generation_id=$1
$$;
CREATE OR REPLACE FUNCTION access.discovery_terms(uuid) RETURNS SETOF access.discovery_term_count
LANGUAGE sql STABLE AS $$
    SELECT d.generation_id,t.term,t.concept,t.work_count,t.concept_count,t.concept_leader,
        t.entry_version,t.retired_version
    FROM access.discovery_generation d CROSS JOIN LATERAL
        access.discovery_terms(coalesce(d.storage_generation,d.generation_id),d.storage_version) t
    WHERE d.generation_id=$1
$$;
CREATE OR REPLACE FUNCTION access.discovery_concepts(uuid) RETURNS SETOF access.discovery_concept_count
LANGUAGE sql STABLE AS $$
    SELECT d.generation_id,c.concept,c.work_count,c.entry_version,c.retired_version
    FROM access.discovery_generation d CROSS JOIN LATERAL
        access.discovery_concepts(coalesce(d.storage_generation,d.generation_id),d.storage_version) c
    WHERE d.generation_id=$1
$$;

-- Equality prefix, keyset order, then version: future versions can be rejected
-- in the index while retained cuts keep the native ordered scan. Live delta
-- probes continue using migration 1044's narrower partial indexes.
-- PostgreSQL 18: https://www.postgresql.org/docs/18/indexes-multicolumn.html
-- Reuse checks need a version range over canonical Works. A range over every
-- posting also tempts small term seeks to scan and sort the whole generation.
DROP INDEX access.discovery_entry_version;
CREATE INDEX discovery_entry_version ON access.discovery_entry (generation_id,entry_version)
    WHERE work_type='' AND term='';
DROP INDEX access.discovery_recent_seek;
CREATE INDEX discovery_recent_seek ON access.discovery_entry
    (generation_id,work_type,term,recent_order,work COLLATE "C",entry_version)
    INCLUDE (retired_version);
DROP INDEX access.discovery_rating_seek;
CREATE INDEX discovery_rating_seek ON access.discovery_entry
    (generation_id,work_type,term,rating_order,work COLLATE "C",entry_version)
    INCLUDE (retired_version) WHERE rating_count>0;
DROP INDEX access.discovery_topic_work;
CREATE INDEX discovery_topic_work ON access.discovery_entry
    (generation_id,work,term,entry_version) INCLUDE (retired_version) WHERE work_type='';
DROP INDEX access.discovery_term_popularity;
CREATE INDEX discovery_term_popularity ON access.discovery_term_count
    (generation_id,work_count DESC,term,entry_version) INCLUDE (retired_version);
DROP INDEX access.discovery_concept_count_seek;
CREATE INDEX discovery_concept_count_seek ON access.discovery_concept_count
    (generation_id,(-work_count),concept,entry_version) INCLUDE (retired_version);
