CREATE TABLE wiki.evidence (
  id text PRIMARY KEY CHECK (id ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
  representation_sha256 text NOT NULL CHECK (representation_sha256 ~ '^[0-9a-f]{64}$'),
  locator jsonb NOT NULL,
  quote text NOT NULL CHECK (char_length(quote) BETWEEN 1 AND 200),
  method jsonb NOT NULL,
  modality text NOT NULL CHECK (modality IN ('narrated','said','rumoured','hypothetical')),
  submitter text NOT NULL,
  rights_basis text NOT NULL CHECK (rights_basis IN ('original_contribution','unprotected_fact','public_domain',
    'license','permission','statutory_exception','service_terms','unknown')),
  source_work text NOT NULL,
  applied_receipt text NOT NULL,
  claim text,
  claim_kind text CHECK (claim_kind IN ('statement','relation')),
  CHECK ((claim IS NULL) = (claim_kind IS NULL))
);
CREATE INDEX wiki_evidence_receipt ON wiki.evidence(applied_receipt);
CREATE INDEX wiki_evidence_claim ON wiki.evidence(claim);
COMMENT ON TABLE wiki.evidence IS 'Externally held passage provenance; disclosure follows the owning graph claim';

-- Provenance is immutable; a delivered graph claim binds once, after its
-- revelation position is recorded in the same Content transaction.
CREATE FUNCTION wiki.guard_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Wiki evidence is retained' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - 'claim' - 'claim_kind') <> (to_jsonb(OLD) - 'claim' - 'claim_kind')
    OR OLD.claim IS NOT NULL AND (NEW.claim IS DISTINCT FROM OLD.claim OR NEW.claim_kind IS DISTINCT FROM OLD.claim_kind)
  THEN RAISE EXCEPTION 'Wiki evidence provenance is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER wiki_evidence_retained BEFORE UPDATE OR DELETE ON wiki.evidence
  FOR EACH ROW EXECUTE FUNCTION wiki.guard_evidence();

-- An external passage is its own material, not a fabricated Content variant.
-- Keep every prior material scope and identity from migration 420.
ALTER TABLE rights.material ADD COLUMN wiki_evidence_id text REFERENCES wiki.evidence(id);
ALTER TABLE rights.material DROP CONSTRAINT material_scope_kind_check;
ALTER TABLE rights.material ADD CONSTRAINT material_scope_kind_check CHECK (scope_kind IN
  ('source_provider','source_record','content_variant','media_asset','work','wiki_evidence'));
ALTER TABLE rights.material ADD CONSTRAINT material_wiki_evidence_scope_check
  CHECK ((scope_kind = 'wiki_evidence') = (wiki_evidence_id IS NOT NULL));
DROP INDEX rights.material_scope_idx;
CREATE UNIQUE INDEX material_scope_idx ON rights.material
  (scope_kind,provider,namespace,source_record_id,content_variant_id,media_asset,work_id,wiki_evidence_id,component)
  NULLS NOT DISTINCT;

-- Registered before a wiki graph write, in the revelation transaction. Retain
-- the requirement if a position is absent so incomplete publication stays hidden.
CREATE TABLE wiki.revelation_record (
  record text PRIMARY KEY CHECK (record ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$')
);
