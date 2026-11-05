-- migrate:up
ALTER TABLE content.media DROP CONSTRAINT media_purpose_check;
ALTER TABLE content.media ADD CONSTRAINT media_purpose_check
  CHECK (purpose IN ('post-image', 'cover', 'avatar', 'realm-icon', 'realm-banner'));
ALTER TABLE content.media ADD COLUMN claimed_realm_id uuid;
ALTER TABLE content.media ADD CONSTRAINT media_realm_asset_check CHECK (
  purpose NOT IN ('realm-icon', 'realm-banner') OR
  (source_url IS NULL AND credit IS NULL AND provenance IS NULL AND claimed_item_id IS NULL)
);
ALTER TABLE content.media ADD CONSTRAINT media_realm_claim_check CHECK (
  claimed_realm_id IS NULL OR
  (purpose IN ('realm-icon', 'realm-banner') AND claimed_realm_id = container_id AND claimed_at IS NOT NULL)
);
CREATE FUNCTION content.guard_realm_media_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.claimed_realm_id IS NOT NULL THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Realm media claims are permanent' USING ERRCODE = '23514';
    END IF;
    IF ROW(NEW.route, NEW.media_id, NEW.container_id, NEW.uploader_id, NEW.purpose, NEW.claimed_at, NEW.claimed_realm_id)
      IS DISTINCT FROM
      ROW(OLD.route, OLD.media_id, OLD.container_id, OLD.uploader_id, OLD.purpose, OLD.claimed_at, OLD.claimed_realm_id) THEN
      RAISE EXCEPTION 'Realm media claims are permanent' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_realm_claim_guard BEFORE UPDATE OR DELETE ON content.media
  FOR EACH ROW EXECUTE FUNCTION content.guard_realm_media_claim();

-- migrate:down
DROP TRIGGER media_realm_claim_guard ON content.media;
DROP FUNCTION content.guard_realm_media_claim();
ALTER TABLE content.media DROP CONSTRAINT media_realm_claim_check;
ALTER TABLE content.media DROP CONSTRAINT media_realm_asset_check;
ALTER TABLE content.media DROP COLUMN claimed_realm_id;
ALTER TABLE content.media DROP CONSTRAINT media_purpose_check;
ALTER TABLE content.media ADD CONSTRAINT media_purpose_check CHECK (purpose IN ('post-image', 'cover', 'avatar'));
