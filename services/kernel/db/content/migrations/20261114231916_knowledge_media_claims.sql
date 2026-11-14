-- migrate:up
ALTER TABLE content.media DROP CONSTRAINT media_purpose_check;
ALTER TABLE content.media ADD CONSTRAINT media_purpose_check
  CHECK (purpose IN ('post-image', 'cover', 'avatar', 'realm-icon', 'realm-banner', 'knowledge-image'));
ALTER TABLE content.media ADD CONSTRAINT media_knowledge_browser_provenance_check CHECK (
  purpose <> 'knowledge-image' OR
  (source_url IS NULL AND credit IS NULL AND provenance IS NULL
   AND claimed_item_id IS NULL AND claimed_realm_id IS NULL)
);

CREATE OR REPLACE FUNCTION content.guard_realm_media_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.purpose = 'knowledge-image' AND OLD.claimed_at IS NOT NULL THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Knowledge media claims are permanent' USING ERRCODE = '23514';
    END IF;
    IF ROW(NEW.route, NEW.media_id, NEW.container_id, NEW.uploader_id, NEW.purpose, NEW.claimed_at)
      IS DISTINCT FROM
      ROW(OLD.route, OLD.media_id, OLD.container_id, OLD.uploader_id, OLD.purpose, OLD.claimed_at) THEN
      RAISE EXCEPTION 'Knowledge media claims are permanent' USING ERRCODE = '23514';
    END IF;
  END IF;
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

ALTER TABLE content.media
  ADD COLUMN knowledge_publication_generation bigint,
  ADD CONSTRAINT media_knowledge_publication_generation_check CHECK (
    knowledge_publication_generation IS NULL OR
    (purpose = 'knowledge-image' AND claimed_at IS NOT NULL AND knowledge_publication_generation >= 0)
  );

-- migrate:down
-- Forward only: immutable revision references and their first Media claims survive rollback.
