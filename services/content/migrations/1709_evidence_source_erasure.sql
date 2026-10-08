-- Content-bound evidence selectors keep source text apart from coordinates and
-- digests. exact, prefix, suffix and quote are source bytes. Any other string
-- that is not a lowercase sha256 under a digest key is source too, including
-- nested legacy values. The one evidence-item mutation removes those strings
-- once this transaction has the referenced revision's tombstone for the same
-- journal id and epoch. Identity, stance, anchors, coordinates, digests and
-- the original manifest stay. Existing rows are not rewritten: a cut can still
-- hold source text until erasure replay after signed coverage comparison.
-- sourceTerminal is the one-way mark that lets the selector unique index keep
-- rejecting duplicate selectors before that transition; two quotes of one
-- anchor would otherwise collide when the source strings leave. It is not
-- source text. The mark can extend the stored object by the few bytes it
-- occupies; admission still refuses a selector above 4096 bytes.

CREATE FUNCTION verification.evidence_source_text_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT ARRAY['exact', 'prefix', 'suffix', 'quote']::text[] $$;

CREATE FUNCTION verification.evidence_digest_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT ARRAY['digest', 'byteDigest', 'sha256', 'representationSha256',
  'locatorDigest', 'quoteDigest', 'requestDigest']::text[] $$;

-- No SET clause: an index expression only accepts a function PostgreSQL treats as immutable.
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
      IF key = 'sourceTerminal' OR key = ANY (verification.evidence_source_text_keys()) THEN
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

-- True when inventory would remove a source string. The terminal mark alone is not source.
CREATE FUNCTION verification.evidence_selector_has_source(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT verification.evidence_selector_retained(value) IS DISTINCT FROM
    CASE pg_catalog.jsonb_typeof(value)
      WHEN 'object' THEN value - 'sourceTerminal'
      ELSE value
    END
$$;

CREATE FUNCTION verification.evidence_item_source_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'immutable verification record' USING ERRCODE = '23514';
  END IF;
  IF OLD.content_revision_id IS NULL
     OR (to_jsonb(OLD) - 'selector') IS DISTINCT FROM (to_jsonb(NEW) - 'selector')
     OR NOT verification.evidence_selector_has_source(OLD.selector)
     OR NEW.selector IS DISTINCT FROM
        verification.evidence_selector_retained(OLD.selector)
        || jsonb_build_object('sourceTerminal', true) THEN
    RAISE EXCEPTION 'immutable verification record' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM content.revision_erasure e
    JOIN content.revision r ON r.id = e.revision_id
    WHERE e.revision_id = OLD.content_revision_id
      AND r.availability = 'erased'
      AND e.erasure_id::text = current_setting('rezics.evidence_source_erasure_id', true)
      AND e.erasure_epoch::text = current_setting('rezics.evidence_source_erasure_epoch', true)
  ) THEN
    RAISE EXCEPTION 'evidence source erasure journal does not match the revision tombstone'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER verification_evidence_item_immutable ON verification.evidence_item;
CREATE TRIGGER verification_evidence_item_immutable
  BEFORE UPDATE OR DELETE ON verification.evidence_item
  FOR EACH ROW EXECUTE FUNCTION verification.evidence_item_source_guard();

-- A terminal mark or a new source string on an erased revision fails at commit,
-- including an insert that skips the update guard.
CREATE FUNCTION verification.evidence_source_terminal() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.content_revision_id IS NOT NULL
     AND verification.evidence_selector_has_source(NEW.selector)
     AND EXISTS (
       SELECT 1 FROM content.revision
       WHERE id = NEW.content_revision_id AND availability = 'erased'
     ) THEN
    RAISE EXCEPTION 'erased revision cannot gain source text' USING ERRCODE = '23514';
  END IF;
  IF NEW.content_revision_id IS NOT NULL
     AND (NEW.selector->'sourceTerminal') = 'true'::jsonb
     AND (NEW.selector IS DISTINCT FROM verification.evidence_selector_retained(NEW.selector)
          || jsonb_build_object('sourceTerminal', true)
       OR NOT EXISTS (
         SELECT 1 FROM content.revision_erasure e
         JOIN content.revision r ON r.id = e.revision_id
         WHERE e.revision_id = NEW.content_revision_id
           AND r.availability = 'erased'
           AND e.erasure_id::text = current_setting('rezics.evidence_source_erasure_id', true)
           AND e.erasure_epoch::text = current_setting('rezics.evidence_source_erasure_epoch', true)
       )) THEN
    RAISE EXCEPTION 'evidence source terminal requires the matching revision tombstone'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER evidence_source_terminal
  AFTER INSERT OR UPDATE ON verification.evidence_item
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION verification.evidence_source_terminal();

-- Duplicate full selectors stay forbidden. to_jsonb and jsonb_build_array are
-- stable in this PostgreSQL, so the terminal key is text: the ordinal plus the
-- selector without its mark. Non-terminal rows stay unique on the selector text.
DROP INDEX verification.evidence_item_identity;
CREATE UNIQUE INDEX evidence_item_identity ON verification.evidence_item (
  revision_id,
  stance,
  (COALESCE(observation_id::text, content_revision_id::text, graph_reference)),
  (CASE
     WHEN content_revision_id IS NOT NULL AND (selector->'sourceTerminal') = 'true'::jsonb
       THEN ordinal::text
     ELSE ''
   END),
  (CASE
     WHEN content_revision_id IS NOT NULL AND (selector->'sourceTerminal') = 'true'::jsonb
       THEN (selector - 'sourceTerminal')::text
     ELSE selector::text
   END)
);

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
  jsonb_typeof(selector) = 'object'
  AND (
    octet_length(selector::text) <= 4096
    OR (
      (selector->'sourceTerminal') = 'true'::jsonb
      AND octet_length(selector::text) <= 4128
      AND NOT verification.evidence_selector_has_source(selector)
    )
  )
);

-- Names the journal identity for the guard, then clears every still-present
-- source string on the locked revisions. A second call updates nothing.
-- The revision must already be erased in this transaction. Callers lock it
-- before inviting a concurrent evidence insert.
CREATE FUNCTION verification.erase_evidence_sources(revision_ids uuid[], erasure uuid, epoch bigint)
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  updated integer;
BEGIN
  IF erasure IS NULL OR epoch IS NULL OR epoch < 1 OR revision_ids IS NULL THEN
    RAISE EXCEPTION 'evidence source erasure journal identity is invalid' USING ERRCODE = '23514';
  END IF;
  PERFORM set_config('rezics.evidence_source_erasure_id', erasure::text, true);
  PERFORM set_config('rezics.evidence_source_erasure_epoch', epoch::text, true);
  PERFORM 1 FROM content.revision
    WHERE id = ANY (revision_ids)
    ORDER BY id
    FOR UPDATE;
  -- The matching tombstone is required even when no source text remains, so a
  -- wrong journal id cannot look like a successful second clear.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.unnest(revision_ids) AS requested(id)
    WHERE NOT EXISTS (
      SELECT 1
      FROM content.revision_erasure e
      JOIN content.revision r ON r.id = e.revision_id
      WHERE e.revision_id = requested.id
        AND r.availability = 'erased'
        AND e.erasure_id::text = pg_catalog.current_setting('rezics.evidence_source_erasure_id', true)
        AND e.erasure_epoch::text = pg_catalog.current_setting('rezics.evidence_source_erasure_epoch', true)
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
    SET selector = verification.evidence_selector_retained(selector)
      || jsonb_build_object('sourceTerminal', true)
    WHERE content_revision_id = ANY (revision_ids)
      AND verification.evidence_selector_has_source(selector);
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated;
END $$;

-- Content-bound rows whose selectors still hold source bytes. Replay uses this
-- after coverage comparison; it does not rewrite them.
CREATE FUNCTION verification.open_evidence_source_revisions(revision_ids uuid[])
RETURNS TABLE (revision_id uuid)
LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $$
  SELECT DISTINCT i.content_revision_id
  FROM verification.evidence_item i
  WHERE i.content_revision_id = ANY (revision_ids)
    AND verification.evidence_selector_has_source(i.selector)
  ORDER BY 1
$$;

DO $$
BEGIN
  IF verification.evidence_selector_retained('{"exact":"quote","start":1,"digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'::jsonb)
     IS DISTINCT FROM '{"start":1,"digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'::jsonb THEN
    RAISE EXCEPTION 'evidence selector inventory drifted';
  END IF;
  IF verification.evidence_selector_has_source('{"start":1}'::jsonb) THEN
    RAISE EXCEPTION 'coordinate selector was classified as source';
  END IF;
  IF NOT verification.evidence_selector_has_source('{"locator":{"label":"legacy","position":1}}'::jsonb) THEN
    RAISE EXCEPTION 'legacy nested string was not classified as source';
  END IF;
END $$;
