-- migrate:up
-- Logical availability already exists. Make the point decision irreversible:
-- physical cleanup may run later, but neither an edit nor a retry may reopen it.
CREATE FUNCTION content.guard_post_erasure() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.availability = 'erased' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Erased post identity must survive cleanup' USING ERRCODE = '23514';
    END IF;
    IF NEW.availability <> 'erased' OR NEW.head_revision_id IS DISTINCT FROM OLD.head_revision_id THEN
      RAISE EXCEPTION 'Logical post erasure is irreversible' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW.availability IS DISTINCT FROM OLD.availability
     AND NEW.security_revision <= OLD.security_revision THEN
    RAISE EXCEPTION 'Post erasure requires an increasing security revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER post_erasure_guard BEFORE UPDATE OR DELETE ON content.post
FOR EACH ROW EXECUTE FUNCTION content.guard_post_erasure();

-- Retain the authoritative routed identity and digest while remote prefix
-- deletion is retried. Collection continues to own only its non-erased rows.
CREATE FUNCTION content.guard_media_erasure() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.erased THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Erased media identity must survive cleanup' USING ERRCODE = '23514';
    END IF;
    IF NOT NEW.erased OR
       ROW(NEW.route, NEW.media_id, NEW.container_id, NEW.uploader_id, NEW.key,
           NEW.sha256, NEW.actual_byte_count, NEW.state, NEW.decision)
       IS DISTINCT FROM
       ROW(OLD.route, OLD.media_id, OLD.container_id, OLD.uploader_id, OLD.key,
           OLD.sha256, OLD.actual_byte_count, OLD.state, OLD.decision) THEN
      RAISE EXCEPTION 'Media erasure and exact identity are irreversible' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW.erased IS DISTINCT FROM OLD.erased AND NEW.security_revision <= OLD.security_revision THEN
    RAISE EXCEPTION 'Media erasure requires an increasing security revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER media_erasure_guard BEFORE UPDATE OR DELETE ON content.media
FOR EACH ROW EXECUTE FUNCTION content.guard_media_erasure();

-- migrate:down
-- Forward only: committed erasure decisions and exact identities must survive.
