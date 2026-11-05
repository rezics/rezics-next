-- migrate:up
-- Existing subject-only rows deliberately retain SQL NULL. Never backfill from subjects or payments.
CREATE FUNCTION commerce.valid_content_edition(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  benefit jsonb := value->'benefit';
  resource jsonb := benefit->'resource';
  version jsonb := benefit->'version';
  source jsonb := value->'source';
  native_id uuid;
BEGIN
  IF octet_length(value::text) > 4096 THEN RETURN false; END IF;
  IF NOT COALESCE(
    jsonb_typeof(value) = 'object' AND
    value - ARRAY['benefit','creatorAccountId','targetSubjectId','source','saleTermsReference','delivery','acquisition','quantity'] = '{}'::jsonb AND
    jsonb_typeof(benefit) = 'object' AND
    benefit - ARRAY['kind','resourceType','resource','version','action'] = '{}'::jsonb AND
    benefit->>'kind' = 'content-edition' AND benefit->>'resourceType' = 'content.edition' AND benefit->>'action' = 'edition:read' AND
    jsonb_typeof(resource) = 'object' AND resource - ARRAY['route','id'] = '{}'::jsonb AND
    jsonb_typeof(resource->'route') = 'number' AND resource->>'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
    jsonb_typeof(version) = 'object' AND version - ARRAY['revisionId','sha256'] = '{}'::jsonb AND
    version->>'revisionId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND version->>'sha256' ~ '^[a-f0-9]{64}$' AND
    value->>'creatorAccountId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND value->>'targetSubjectId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
    jsonb_typeof(source) = 'object' AND source - ARRAY['threadId','postId','licence'] = '{}'::jsonb AND
    source->>'threadId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND source->>'postId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
    jsonb_typeof(source->'licence') = 'string' AND char_length(source->>'licence') BETWEEN 1 AND 256 AND
    jsonb_typeof(value->'saleTermsReference') = 'string' AND char_length(value->>'saleTermsReference') BETWEEN 1 AND 256 AND
    value->>'delivery' = 'fixed-content-edition' AND value->>'acquisition' = 'one-time-account-bound' AND
    value->'quantity' = '1'::jsonb,
    false) THEN RETURN false; END IF;
  native_id := (resource->>'id')::uuid;
  RETURN (resource->>'route')::integer = get_byte(uuid_send(native_id), 10) * 256 + get_byte(uuid_send(native_id), 11)
     AND (resource->>'route')::numeric = (resource->>'route')::integer;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN false;
END;
$$;

CREATE FUNCTION commerce.guard_content_edition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.content_edition IS DISTINCT FROM OLD.content_edition THEN
    RAISE EXCEPTION 'Captured Content edition is immutable, including unknown historical mapping' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE commerce.offer ADD COLUMN content_edition jsonb
  CHECK (content_edition IS NULL OR commerce.valid_content_edition(content_edition));
ALTER TABLE commerce.offer ADD CONSTRAINT offer_edition_subject CHECK
  (content_edition IS NULL OR content_edition->>'targetSubjectId' = target_subject_id::text);
ALTER TABLE commerce.offer ADD CONSTRAINT offer_edition_creator CHECK
  (content_edition IS NULL OR content_edition->>'creatorAccountId' = creator_account_id::text);
CREATE TRIGGER offer_content_edition_guard BEFORE UPDATE ON commerce.offer
FOR EACH ROW EXECUTE FUNCTION commerce.guard_content_edition();

ALTER TABLE commerce.purchase_order ADD COLUMN content_edition jsonb
  CHECK (content_edition IS NULL OR commerce.valid_content_edition(content_edition));
ALTER TABLE commerce.purchase_order ADD CONSTRAINT purchase_order_edition_subject CHECK
  (content_edition IS NULL OR content_edition->>'targetSubjectId' = target_subject_id::text);
ALTER TABLE commerce.purchase_order ADD CONSTRAINT purchase_order_edition_creator CHECK
  (content_edition IS NULL OR content_edition->>'creatorAccountId' = creator_account_id::text);
CREATE TRIGGER purchase_order_content_edition_guard BEFORE UPDATE ON commerce.purchase_order
FOR EACH ROW EXECUTE FUNCTION commerce.guard_content_edition();

ALTER TABLE commerce.entitlement ADD COLUMN content_edition jsonb
  CHECK (content_edition IS NULL OR commerce.valid_content_edition(content_edition));
ALTER TABLE commerce.entitlement ADD CONSTRAINT entitlement_edition_subject CHECK
  (content_edition IS NULL OR content_edition->>'targetSubjectId' = target_subject_id::text);
CREATE TRIGGER entitlement_content_edition_guard BEFORE UPDATE ON commerce.entitlement
FOR EACH ROW EXECUTE FUNCTION commerce.guard_content_edition();

CREATE FUNCTION commerce.guard_offer_target() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.route, NEW.offer_id, NEW.creator_account_id, NEW.target_subject_id, NEW.title, NEW.currency, NEW.tax_code, NEW.royalty_basis_points)
     IS DISTINCT FROM
     (OLD.route, OLD.offer_id, OLD.creator_account_id, OLD.target_subject_id, OLD.title, OLD.currency, OLD.tax_code, OLD.royalty_basis_points) THEN
    RAISE EXCEPTION 'Offer target and non-price terms are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER offer_target_guard BEFORE UPDATE ON commerce.offer
FOR EACH ROW EXECUTE FUNCTION commerce.guard_offer_target();

-- migrate:down
DROP TRIGGER offer_target_guard ON commerce.offer;
DROP FUNCTION commerce.guard_offer_target();
DROP TRIGGER entitlement_content_edition_guard ON commerce.entitlement;
ALTER TABLE commerce.entitlement DROP COLUMN content_edition;
DROP TRIGGER purchase_order_content_edition_guard ON commerce.purchase_order;
ALTER TABLE commerce.purchase_order DROP COLUMN content_edition;
DROP TRIGGER offer_content_edition_guard ON commerce.offer;
ALTER TABLE commerce.offer DROP COLUMN content_edition;
DROP FUNCTION commerce.guard_content_edition();
DROP FUNCTION commerce.valid_content_edition(jsonb);
