-- Content-bound evidence selectors keep source text apart from coordinates and
-- digests. exact, prefix, suffix and quote are source bytes even when the
-- value is 64 hex digits. Any other string that is not a lowercase sha256 under
-- a digest key is source too, including nested legacy values. The one
-- evidence-item mutation removes those strings once, under the referenced
-- revision's tombstone. The journal id and epoch are columns on that row, so
-- the check is immediate and does not read a transaction-wide setting.
-- Identity, stance, anchors, ordinal, coordinates, digests and the original
-- manifest stay. Existing rows are not rewritten. A caller-owned selector key
-- is not this terminal state. The selector octet bound stays 4096.

CREATE FUNCTION verification.evidence_source_text_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT ARRAY['exact', 'prefix', 'suffix', 'quote']::text[] $$;

CREATE FUNCTION verification.evidence_digest_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT ARRAY['digest', 'byteDigest', 'sha256', 'representationSha256',
  'locatorDigest', 'quoteDigest', 'requestDigest']::text[] $$;

CREATE FUNCTION verification.evidence_selector_retained(value jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
AS $$
DECLARE
  key text;
  child jsonb;
  element jsonb;
  kept jsonb;
  result jsonb;
BEGIN
  IF pg_catalog.jsonb_typeof(value) = 'object' THEN
    result := '{}'::jsonb;
    FOR key, child IN SELECT * FROM pg_catalog.jsonb_each(value) LOOP
      IF key = ANY (verification.evidence_source_text_keys()) THEN
        CONTINUE;
      ELSIF pg_catalog.jsonb_typeof(child) = 'string' THEN
        IF key = ANY (verification.evidence_digest_keys())
           AND (child #>> '{}') ~ '^[0-9a-f]{64}$' THEN
          result := result || pg_catalog.jsonb_build_object(key, child);
        END IF;
      ELSIF pg_catalog.jsonb_typeof(child) = 'object' OR pg_catalog.jsonb_typeof(child) = 'array' THEN
        result := result || pg_catalog.jsonb_build_object(key, verification.evidence_selector_retained(child));
      ELSE
        result := result || pg_catalog.jsonb_build_object(key, child);
      END IF;
    END LOOP;
    RETURN result;
  ELSIF pg_catalog.jsonb_typeof(value) = 'array' THEN
    kept := '[]'::jsonb;
    FOR element IN SELECT * FROM pg_catalog.jsonb_array_elements(value) LOOP
      IF pg_catalog.jsonb_typeof(element) = 'string' THEN
        CONTINUE;
      ELSIF pg_catalog.jsonb_typeof(element) = 'object' OR pg_catalog.jsonb_typeof(element) = 'array' THEN
        kept := kept || pg_catalog.jsonb_build_array(verification.evidence_selector_retained(element));
      ELSE
        kept := kept || pg_catalog.jsonb_build_array(element);
      END IF;
    END LOOP;
    RETURN kept;
  ELSE
    RETURN value;
  END IF;
END $$;

-- True when inventory would remove a source string. A caller-owned key is not special.
CREATE FUNCTION verification.evidence_selector_has_source(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT verification.evidence_selector_retained(value) IS DISTINCT FROM value
$$;

ALTER TABLE verification.evidence_item
  ADD COLUMN source_terminal boolean NOT NULL DEFAULT false,
  ADD COLUMN source_erasure_id uuid,
  ADD COLUMN source_erasure_epoch bigint,
  ADD CONSTRAINT evidence_item_source_terminal_bound CHECK (
    (NOT source_terminal AND source_erasure_id IS NULL AND source_erasure_epoch IS NULL)
    OR (source_terminal AND source_erasure_id IS NOT NULL AND source_erasure_epoch >= 1)
  );

CREATE FUNCTION verification.evidence_item_source_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'immutable verification record' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.source_terminal OR NEW.source_erasure_id IS NOT NULL OR NEW.source_erasure_epoch IS NOT NULL THEN
      RAISE EXCEPTION 'immutable verification record' USING ERRCODE = '23514';
    END IF;
    IF NEW.content_revision_id IS NOT NULL
       AND verification.evidence_selector_has_source(NEW.selector)
       AND EXISTS (
         SELECT 1 FROM content.revision
         WHERE id = NEW.content_revision_id AND availability = 'erased'
       ) THEN
      RAISE EXCEPTION 'erased revision cannot gain source text' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.content_revision_id IS NULL
     OR NOT verification.evidence_selector_has_source(OLD.selector)
     OR verification.evidence_selector_has_source(NEW.selector)
     OR NOT NEW.source_terminal
     OR NEW.source_erasure_id IS NULL
     OR NEW.source_erasure_epoch IS NULL
     OR NEW.source_erasure_epoch < 1
     OR NEW.selector IS DISTINCT FROM verification.evidence_selector_retained(OLD.selector)
     OR (to_jsonb(OLD) - 'selector' - 'source_terminal' - 'source_erasure_id' - 'source_erasure_epoch')
        IS DISTINCT FROM (to_jsonb(NEW) - 'selector' - 'source_terminal' - 'source_erasure_id' - 'source_erasure_epoch') THEN
    RAISE EXCEPTION 'immutable verification record' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM content.revision_erasure e
    JOIN content.revision r ON r.id = e.revision_id
    WHERE e.revision_id = OLD.content_revision_id
      AND r.availability = 'erased'
      AND e.erasure_id = NEW.source_erasure_id
      AND e.erasure_epoch = NEW.source_erasure_epoch
  ) THEN
    RAISE EXCEPTION 'evidence source erasure journal does not match the revision tombstone'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER verification_evidence_item_immutable ON verification.evidence_item;
CREATE TRIGGER verification_evidence_item_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON verification.evidence_item
  FOR EACH ROW EXECUTE FUNCTION verification.evidence_item_source_guard();

-- Available rows keep the original selector identity. Terminal rows leave that
-- index, so two redacted quotes of one anchor do not collide, and a duplicate
-- available selector still does.
DROP INDEX verification.evidence_item_identity;
CREATE UNIQUE INDEX evidence_item_identity ON verification.evidence_item (
  revision_id,
  stance,
  (COALESCE(observation_id::text, content_revision_id::text, graph_reference)),
  selector
) WHERE NOT source_terminal;

CREATE INDEX evidence_item_open_source ON verification.evidence_item (content_revision_id)
  WHERE content_revision_id IS NOT NULL AND NOT source_terminal;

DO $$
DECLARE legacy record;
BEGIN
  FOR legacy IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
    WHERE con.conrelid = 'verification.evidence_item'::regclass
      AND con.contype = 'c'
      AND att.attname = 'selector'
      AND cardinality(con.conkey) = 1
  LOOP
    EXECUTE format('ALTER TABLE verification.evidence_item DROP CONSTRAINT %I', legacy.conname);
  END LOOP;
END $$;

ALTER TABLE verification.evidence_item ADD CONSTRAINT evidence_item_selector_bound CHECK (
  jsonb_typeof(selector) = 'object' AND octet_length(selector::text) <= 4096
);

-- Clears source text on the locked revisions. The journal arguments are written
-- onto each changed row; a later call in the same transaction cannot replace them.
-- The revision must already be erased. Callers lock it before a concurrent insert.
CREATE FUNCTION verification.erase_evidence_sources(revision_ids uuid[], erasure uuid, epoch bigint)
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog
SET lock_timeout = '2s'
SET statement_timeout = '5s'
AS $$
DECLARE
  updated integer;
BEGIN
  IF erasure IS NULL OR epoch IS NULL OR epoch < 1 OR revision_ids IS NULL
     OR cardinality(revision_ids) > 64 THEN
    RAISE EXCEPTION 'evidence source erasure journal identity is invalid' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM content.revision
    WHERE id = ANY (revision_ids)
    ORDER BY id
    FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.unnest(revision_ids) AS requested(id)
    WHERE NOT EXISTS (
      SELECT 1
      FROM content.revision_erasure e
      JOIN content.revision r ON r.id = e.revision_id
      WHERE e.revision_id = requested.id
        AND r.availability = 'erased'
        AND e.erasure_id = erasure
        AND e.erasure_epoch = epoch
    )
  ) THEN
    RAISE EXCEPTION 'evidence source erasure journal does not match the revision tombstone'
      USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM verification.evidence_item
    WHERE content_revision_id = ANY (revision_ids)
    ORDER BY revision_id, ordinal
    FOR UPDATE;
  UPDATE verification.evidence_item
    SET selector = verification.evidence_selector_retained(selector),
        source_terminal = true,
        source_erasure_id = erasure,
        source_erasure_epoch = epoch
    WHERE content_revision_id = ANY (revision_ids)
      AND verification.evidence_selector_has_source(selector);
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated;
END $$;

-- Bounded probe: one indexed existence check per requested revision, at most 64.
CREATE FUNCTION verification.open_evidence_source_revisions(revision_ids uuid[])
RETURNS TABLE (revision_id uuid)
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog
SET statement_timeout = '5s'
AS $$
BEGIN
  IF revision_ids IS NULL OR cardinality(revision_ids) > 64 THEN
    RAISE EXCEPTION 'evidence source probe exceeds its bound' USING ERRCODE = '23514';
  END IF;
  RETURN QUERY
  SELECT r.id
  FROM content.revision r
  WHERE r.id = ANY (revision_ids)
    AND EXISTS (
      SELECT 1 FROM verification.evidence_item i
      WHERE i.content_revision_id = r.id
        AND NOT i.source_terminal
        AND verification.evidence_selector_has_source(i.selector)
    )
  ORDER BY 1;
END $$;

DO $$
DECLARE hex text := repeat('ab', 32);
BEGIN
  IF verification.evidence_selector_retained(jsonb_build_object('exact', 'quote', 'start', 1, 'digest', hex))
     IS DISTINCT FROM jsonb_build_object('start', 1, 'digest', hex) THEN
    RAISE EXCEPTION 'evidence selector inventory drifted';
  END IF;
  IF verification.evidence_selector_retained(jsonb_build_object('exact', hex, 'start', 1))
     IS DISTINCT FROM jsonb_build_object('start', 1) THEN
    RAISE EXCEPTION 'source field was kept because it looked like a digest';
  END IF;
  IF verification.evidence_selector_has_source('{"start":1}'::jsonb) THEN
    RAISE EXCEPTION 'coordinate selector was classified as source';
  END IF;
  IF verification.evidence_selector_has_source('{"sourceTerminal":true}'::jsonb) THEN
    RAISE EXCEPTION 'caller-owned terminal key was classified as source text';
  END IF;
  IF NOT verification.evidence_selector_has_source('{"locator":{"label":"legacy","position":1}}'::jsonb) THEN
    RAISE EXCEPTION 'legacy nested string was not classified as source';
  END IF;
END $$;
