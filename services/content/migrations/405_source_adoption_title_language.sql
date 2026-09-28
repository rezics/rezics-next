-- Preserve the evidence and decision used for a native Work's initial title.
-- The same resolver backfills legacy intents and serves new adoptions.
CREATE FUNCTION source.infer_title_language(title text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF title ~ '[ぁ-ゟ゠-ヿ]' THEN RETURN 'ja'; END IF;
  IF title ~ '[가-힣ᄀ-ᇿ]' THEN RETURN 'ko'; END IF;
  IF title ~ '[一-鿿㐀-䶿]' THEN
    -- Distinct traditional forms take precedence; shared Han forms default to Hans.
    IF title ~ '[國義記遊體學書車門風雲龍馬鳥魚語讀說寫與萬東長廣開關傳會時發後對畫畫愛樂歷點無麵麥葉聖臺灣詩劍劉張陳羅吳孫紅樓夢]' THEN
      RETURN 'zh-Hant';
    END IF;
    RETURN 'zh-Hans';
  END IF;
  RETURN 'und';
END $$;

CREATE FUNCTION source.normalized_record_language(value text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE code text := lower(trim(value));
BEGIN
  IF code LIKE '/languages/%' THEN code := substr(code, 12); END IF;
  IF code = 'und' THEN RETURN NULL; END IF;
  IF code IN ('chi', 'zho', 'zh') THEN
    -- Keep unspecified Chinese script until the adopted Work title is known.
    RETURN 'zh';
  END IF;
  IF code IN ('eng', 'en') THEN RETURN 'en'; END IF;
  IF code IN ('jpn', 'ja') THEN RETURN 'ja'; END IF;
  IF code IN ('kor', 'ko') THEN RETURN 'ko'; END IF;
  IF code IN ('fre', 'fra') THEN RETURN 'fr'; END IF;
  IF code IN ('ger', 'deu') THEN RETURN 'de'; END IF;
  IF code = 'spa' THEN RETURN 'es'; END IF;
  IF code = 'ita' THEN RETURN 'it'; END IF;
  IF code = 'rus' THEN RETURN 'ru'; END IF;
  IF code = 'por' THEN RETURN 'pt'; END IF;
  IF value ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' AND length(value) <= 35 THEN
    RETURN value;
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION source.open_library_record_language(raw bytea) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE body jsonb; entry jsonb; found text; candidate text; language_value jsonb;
BEGIN
  IF raw IS NULL OR octet_length(raw) > 65536 THEN RETURN NULL; END IF;
  BEGIN
    body := convert_from(raw, 'UTF8')::jsonb;
  EXCEPTION WHEN others THEN RETURN NULL;
  END;
  IF jsonb_typeof(body) <> 'object' THEN RETURN NULL; END IF;
  language_value := body->'languages';
  IF jsonb_typeof(language_value) = 'array' THEN
    IF jsonb_array_length(language_value) > 16 THEN RETURN NULL; END IF;
    FOR entry IN SELECT value FROM jsonb_array_elements(language_value) LOOP
      candidate := source.normalized_record_language(entry->>'key');
      IF candidate IS NULL THEN RETURN NULL; END IF;
      IF found IS NOT NULL AND candidate <> found THEN RETURN NULL; END IF;
      found := candidate;
    END LOOP;
    RETURN found;
  END IF;
  language_value := body->'language';
  IF jsonb_typeof(language_value) = 'string' THEN
    RETURN source.normalized_record_language(body->>'language');
  END IF;
  RETURN NULL;
END $$;

-- An indexed, immutable relation avoids scanning retained Edition JSON on every
-- adoption. Only complete, retained Edition observations can provide a language.
CREATE TABLE source.edition_work_language (
  observation_id uuid NOT NULL REFERENCES source.observation(id),
  principal_id uuid NOT NULL,
  work_key text NOT NULL CHECK (work_key ~ '^/works/OL[1-9][0-9]{0,11}W$'),
  language text NOT NULL CHECK (language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
    AND length(language) <= 35),
  submitted_at timestamptz NOT NULL,
  PRIMARY KEY (observation_id, work_key)
);
CREATE INDEX edition_work_language_lookup_idx ON source.edition_work_language
  (principal_id, work_key, submitted_at DESC, observation_id DESC);
CREATE TRIGGER edition_work_language_immutable BEFORE UPDATE OR DELETE ON source.edition_work_language
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();

CREATE FUNCTION source.index_edition_work_language(target uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE row record; body jsonb; reference jsonb; language_value text;
BEGIN
  SELECT o.id, o.principal_id, o.raw_bytes, o.coverage, o.retention,
    o.submitted_at, r.provider, r.namespace, r.external_id INTO row
    FROM source.observation o JOIN source.record r ON r.id = o.record_id WHERE o.id = target;
  IF NOT FOUND OR row.provider <> 'open-library' OR row.namespace <> 'edition'
    OR row.retention <> 'retained' OR row.coverage->>'complete' <> 'true'
    OR row.coverage->>'scope' <> 'open-library-edition-response-v1' THEN RETURN; END IF;
  BEGIN
    body := convert_from(row.raw_bytes, 'UTF8')::jsonb;
  EXCEPTION WHEN others THEN RETURN;
  END;
  IF jsonb_typeof(body) <> 'object' OR body->>'key' <> '/books/' || row.external_id
    OR jsonb_typeof(body->'works') <> 'array'
    OR jsonb_array_length(body->'works') > 32 THEN RETURN; END IF;
  language_value := source.open_library_record_language(row.raw_bytes);
  IF language_value IS NULL THEN RETURN; END IF;
  FOR reference IN SELECT value FROM jsonb_array_elements(body->'works') LOOP
    IF reference->>'key' ~ '^/works/OL[1-9][0-9]{0,11}W$' THEN
      INSERT INTO source.edition_work_language
        (observation_id, principal_id, work_key, language, submitted_at)
        VALUES (row.id, row.principal_id, reference->>'key', language_value, row.submitted_at)
        ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
END $$;

CREATE FUNCTION source.index_edition_work_language_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM source.index_edition_work_language(NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER source_edition_work_language_insert AFTER INSERT ON source.observation
  FOR EACH ROW EXECUTE FUNCTION source.index_edition_work_language_insert();
DO $$ DECLARE item record;
BEGIN
  FOR item IN SELECT o.id FROM source.observation o JOIN source.record r ON r.id = o.record_id
    WHERE r.provider = 'open-library' AND r.namespace = 'edition' AND o.retention = 'retained' LOOP
    PERFORM source.index_edition_work_language(item.id);
  END LOOP;
END $$;

-- One proposal/observation lookup and at most one indexed Edition lookup per
-- adoption. The Edition lookup never scans raw observations or their JSON.
CREATE FUNCTION source.resolve_native_title_language(target uuid, explicit text DEFAULT NULL)
RETURNS TABLE(language text, basis text, observation_id uuid)
LANGUAGE plpgsql STABLE AS $$
DECLARE proposal record; recorded text; edition record;
BEGIN
  SELECT p.principal_id, p.candidate_title, p.observation_id, o.raw_bytes,
    r.provider, r.namespace, r.external_id INTO proposal
    FROM source.native_work_proposal p
    JOIN source.observation o ON o.id = p.observation_id
    JOIN source.record r ON r.id = p.record_id WHERE p.id = target;
  IF NOT FOUND THEN RAISE EXCEPTION 'source proposal is unavailable'; END IF;
  IF explicit IS NOT NULL THEN
    IF explicit !~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' OR length(explicit) > 35 THEN
      RAISE EXCEPTION 'invalid title language' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY SELECT explicit, 'explicit'::text, NULL::uuid;
    RETURN;
  END IF;
  IF proposal.provider = 'open-library' AND proposal.namespace = 'work' THEN
    recorded := source.open_library_record_language(proposal.raw_bytes);
    IF recorded IS NOT NULL THEN
      IF recorded = 'zh' THEN
        recorded := CASE WHEN source.infer_title_language(proposal.candidate_title) = 'zh-Hant'
          THEN 'zh-Hant' ELSE 'zh-Hans' END;
      END IF;
      RETURN QUERY SELECT recorded, 'work'::text, proposal.observation_id;
      RETURN;
    END IF;
    SELECT e.language, e.observation_id INTO edition
      FROM source.edition_work_language e
      WHERE e.principal_id = proposal.principal_id
        AND e.work_key = '/works/' || proposal.external_id
      ORDER BY e.submitted_at DESC, e.observation_id DESC LIMIT 1;
    IF FOUND THEN
      RETURN QUERY SELECT CASE WHEN edition.language = 'zh'
        THEN CASE WHEN source.infer_title_language(proposal.candidate_title) = 'zh-Hant'
          THEN 'zh-Hant' ELSE 'zh-Hans' END
        ELSE edition.language END, 'edition'::text, edition.observation_id;
      RETURN;
    END IF;
  END IF;
  RETURN QUERY SELECT source.infer_title_language(proposal.candidate_title),
    'inferred'::text, NULL::uuid;
END $$;

ALTER TABLE source.native_work_adoption_intent
  DROP CONSTRAINT native_work_adoption_intent_title_language_check;
ALTER TABLE source.native_work_adoption_intent
  ADD COLUMN title_language_basis text,
  ADD COLUMN title_language_observation_id uuid REFERENCES source.observation(id),
  ADD COLUMN activation_language text,
  ADD COLUMN request_title_language text;
ALTER TABLE source.native_work_adoption_intent DISABLE TRIGGER source_native_work_adoption_intent_immutable;
DO $$ DECLARE item record; resolved record;
BEGIN
  FOR item IN SELECT id, proposal_id, title_language FROM source.native_work_adoption_intent LOOP
    SELECT * INTO resolved FROM source.resolve_native_title_language(item.proposal_id, NULL);
    UPDATE source.native_work_adoption_intent SET title_language = resolved.language,
      title_language_basis = resolved.basis,
      title_language_observation_id = resolved.observation_id,
      -- A sealed legacy graph receipt still commits the original language.
      activation_language = CASE WHEN EXISTS (SELECT 1 FROM source.native_work_binding b
        WHERE b.intent_id = item.id) THEN item.title_language ELSE resolved.language END,
      request_title_language = item.title_language
      WHERE id = item.id;
  END LOOP;
END $$;
ALTER TABLE source.native_work_adoption_intent ENABLE TRIGGER source_native_work_adoption_intent_immutable;
ALTER TABLE source.native_work_adoption_intent
  ALTER COLUMN title_language_basis SET NOT NULL,
  ALTER COLUMN activation_language SET NOT NULL,
  ADD CONSTRAINT native_work_adoption_intent_language_bcp47 CHECK
    (title_language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' AND length(title_language) <= 35
      AND activation_language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' AND length(activation_language) <= 35
      AND (request_title_language IS NULL OR
        (request_title_language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
          AND length(request_title_language) <= 35))),
  ADD CONSTRAINT native_work_adoption_intent_language_basis CHECK
    (title_language_basis IN ('explicit', 'work', 'edition', 'inferred')
      AND ((title_language_basis IN ('work', 'edition')) =
        (title_language_observation_id IS NOT NULL)));
