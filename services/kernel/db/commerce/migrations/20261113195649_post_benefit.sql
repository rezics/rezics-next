-- migrate:up
-- A Post-wide promise is a separate immutable capture. Existing editions and
-- historical subject-only rows remain untouched and unknown.
CREATE FUNCTION commerce.valid_content_post(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE benefit jsonb; resource jsonb; native_id uuid; native_route integer;
BEGIN
  IF octet_length(value::text) > 4096 OR jsonb_typeof(value) <> 'object'
     OR NOT value ?& ARRAY['benefit','creatorAccountId','targetSubjectId','saleTermsReference','delivery','acquisition','quantity']
     OR value - ARRAY['benefit','creatorAccountId','targetSubjectId','saleTermsReference','delivery','acquisition','quantity'] <> '{}'::jsonb
     OR value->>'saleTermsReference' IS DISTINCT FROM 'content-post-revisions-v1'
     OR value->>'delivery' IS DISTINCT FROM 'eligible-post-revisions'
     OR value->>'acquisition' IS DISTINCT FROM 'one-time-account-bound'
     OR value->'quantity' IS DISTINCT FROM '1'::jsonb THEN RETURN false; END IF;
  benefit := value->'benefit';
  IF jsonb_typeof(benefit) <> 'object'
     OR NOT benefit ?& ARRAY['kind','resourceType','resource','action']
     OR benefit - ARRAY['kind','resourceType','resource','action'] <> '{}'::jsonb
     OR benefit->>'kind' IS DISTINCT FROM 'content-post'
     OR benefit->>'resourceType' IS DISTINCT FROM 'content.post'
     OR benefit->>'action' IS DISTINCT FROM 'post:read' THEN RETURN false; END IF;
  resource := benefit->'resource';
  IF jsonb_typeof(resource) <> 'object'
     OR NOT resource ?& ARRAY['route','id']
     OR resource - ARRAY['route','id'] <> '{}'::jsonb
     OR jsonb_typeof(resource->'route') IS DISTINCT FROM 'number'
     OR jsonb_typeof(resource->'id') IS DISTINCT FROM 'string'
     OR jsonb_typeof(value->'creatorAccountId') IS DISTINCT FROM 'string'
     OR jsonb_typeof(value->'targetSubjectId') IS DISTINCT FROM 'string'
     OR resource->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR value->>'creatorAccountId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR value->>'targetSubjectId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  native_id := (resource->>'id')::uuid;
  native_route := get_byte(uuid_send(native_id), 10) * 256 + get_byte(uuid_send(native_id), 11);
  RETURN (resource->>'route')::integer = native_route
     AND (resource->>'route')::numeric = native_route;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN false;
END;
$$;

CREATE FUNCTION commerce.guard_content_post() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.content_post IS DISTINCT FROM OLD.content_post THEN
    RAISE EXCEPTION 'Captured Content Post is immutable, including unknown historical mapping' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE commerce.offer ADD COLUMN content_post jsonb
  CHECK (content_post IS NULL OR commerce.valid_content_post(content_post));
ALTER TABLE commerce.offer ADD CONSTRAINT offer_native_benefit_exclusive CHECK
  (content_post IS NULL OR content_edition IS NULL);
ALTER TABLE commerce.offer ADD CONSTRAINT offer_post_subject CHECK
  (content_post IS NULL OR content_post->>'targetSubjectId' = target_subject_id::text);
ALTER TABLE commerce.offer ADD CONSTRAINT offer_post_creator CHECK
  (content_post IS NULL OR content_post->>'creatorAccountId' = creator_account_id::text);
CREATE TRIGGER offer_content_post_guard BEFORE UPDATE ON commerce.offer
FOR EACH ROW EXECUTE FUNCTION commerce.guard_content_post();

ALTER TABLE commerce.purchase_order ADD COLUMN content_post jsonb
  CHECK (content_post IS NULL OR commerce.valid_content_post(content_post));
ALTER TABLE commerce.purchase_order ADD CONSTRAINT order_native_benefit_exclusive CHECK
  (content_post IS NULL OR content_edition IS NULL);
ALTER TABLE commerce.purchase_order ADD CONSTRAINT order_post_subject CHECK
  (content_post IS NULL OR content_post->>'targetSubjectId' = target_subject_id::text);
ALTER TABLE commerce.purchase_order ADD CONSTRAINT order_post_creator CHECK
  (content_post IS NULL OR content_post->>'creatorAccountId' = creator_account_id::text);
CREATE TRIGGER order_content_post_guard BEFORE UPDATE ON commerce.purchase_order
FOR EACH ROW EXECUTE FUNCTION commerce.guard_content_post();

ALTER TABLE commerce.entitlement ADD COLUMN content_post jsonb
  CHECK (content_post IS NULL OR commerce.valid_content_post(content_post));
ALTER TABLE commerce.entitlement ADD CONSTRAINT entitlement_native_benefit_exclusive CHECK
  (content_post IS NULL OR content_edition IS NULL);
ALTER TABLE commerce.entitlement ADD CONSTRAINT entitlement_post_subject CHECK
  (content_post IS NULL OR content_post->>'targetSubjectId' = target_subject_id::text);
CREATE TRIGGER entitlement_content_post_guard BEFORE UPDATE ON commerce.entitlement
FOR EACH ROW EXECUTE FUNCTION commerce.guard_content_post();

CREATE INDEX purchase_order_post_unresolved
  ON commerce.purchase_order (route, buyer_account_id, (content_post->'benefit'), order_id)
  WHERE content_post IS NOT NULL AND acquisition_release IS NULL;
CREATE INDEX entitlement_post_active
  ON commerce.entitlement (route, account_id, (content_post->'benefit'), entitlement_id)
  WHERE content_post IS NOT NULL AND revoked_at IS NULL AND revoke_reason IS NULL;

-- migrate:down
DROP INDEX commerce.entitlement_post_active;
DROP INDEX commerce.purchase_order_post_unresolved;
DROP TRIGGER entitlement_content_post_guard ON commerce.entitlement;
ALTER TABLE commerce.entitlement DROP CONSTRAINT entitlement_post_subject;
ALTER TABLE commerce.entitlement DROP CONSTRAINT entitlement_native_benefit_exclusive;
ALTER TABLE commerce.entitlement DROP COLUMN content_post;
DROP TRIGGER order_content_post_guard ON commerce.purchase_order;
ALTER TABLE commerce.purchase_order DROP CONSTRAINT order_post_creator;
ALTER TABLE commerce.purchase_order DROP CONSTRAINT order_post_subject;
ALTER TABLE commerce.purchase_order DROP CONSTRAINT order_native_benefit_exclusive;
ALTER TABLE commerce.purchase_order DROP COLUMN content_post;
DROP TRIGGER offer_content_post_guard ON commerce.offer;
ALTER TABLE commerce.offer DROP CONSTRAINT offer_post_creator;
ALTER TABLE commerce.offer DROP CONSTRAINT offer_post_subject;
ALTER TABLE commerce.offer DROP CONSTRAINT offer_native_benefit_exclusive;
ALTER TABLE commerce.offer DROP COLUMN content_post;
DROP FUNCTION commerce.guard_content_post();
DROP FUNCTION commerce.valid_content_post(jsonb);
