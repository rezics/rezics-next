-- migrate:up
CREATE SEQUENCE content.hosted_chapter_language_version;
CREATE TABLE content.hosted_chapter_language_key (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  occurrence_id uuid NOT NULL,
  language text COLLATE "C" NOT NULL CHECK (length(language) BETWEEN 1 AND 63),
  first_version bigint NOT NULL CHECK (first_version > 0),
  PRIMARY KEY (route,catalogue_id,occurrence_id,language),
  FOREIGN KEY (route,catalogue_id,occurrence_id)
    REFERENCES content.hosted_occurrence(route,catalogue_id,occurrence_id) ON DELETE CASCADE
);
CREATE INDEX hosted_chapter_language_page ON content.hosted_chapter_language_key
  (route,catalogue_id,occurrence_id,first_version,language);
CREATE TABLE content.hosted_chapter_language_binding (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  occurrence_id uuid NOT NULL,
  language text COLLATE "C" NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  title text CHECK (length(title) BETWEEN 1 AND 256),
  target jsonb,
  title_redacted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (route,catalogue_id,occurrence_id,language,version),
  FOREIGN KEY (route,catalogue_id,occurrence_id,language)
    REFERENCES content.hosted_chapter_language_key(route,catalogue_id,occurrence_id,language) ON DELETE CASCADE,
  CHECK ((target IS NULL AND title IS NULL AND NOT title_redacted) OR
         (target IS NOT NULL AND ((title IS NOT NULL AND NOT title_redacted) OR
                                  (title IS NULL AND title_redacted))))
);
CREATE INDEX hosted_chapter_language_target ON content.hosted_chapter_language_binding
  ((target->>'postId'),(target->>'revisionId'),route,catalogue_id,occurrence_id,language,version)
  WHERE target IS NOT NULL;
ALTER TABLE content.hosted_publication_staging ADD COLUMN language_occurrence_count bigint NOT NULL DEFAULT 0 CHECK (language_occurrence_count>=0);
ALTER TABLE content.hosted_publication_staging_candidate ADD COLUMN body_languages jsonb;
CREATE INDEX hosted_staging_language_occurrence ON content.hosted_publication_staging_candidate
  (route,catalogue_id,stage_id,source_order) WHERE body_languages IS NOT NULL;
CREATE TABLE content.hosted_publication_language_progress (
  route integer NOT NULL,catalogue_id uuid NOT NULL,stage_id uuid NOT NULL,
  after_source_order bigint NOT NULL DEFAULT -1,
  after_language_version bigint,
  after_language text COLLATE "C",
  complete boolean NOT NULL DEFAULT false,
  PRIMARY KEY (route,catalogue_id,stage_id),
  FOREIGN KEY (route,catalogue_id,stage_id) REFERENCES content.hosted_publication_staging(route,catalogue_id,stage_id) ON DELETE CASCADE,
  CHECK ((after_language_version IS NULL)=(after_language IS NULL))
);
CREATE TABLE content.hosted_publication_language_target (
  route integer NOT NULL,catalogue_id uuid NOT NULL,stage_id uuid NOT NULL,
  thread_id uuid NOT NULL,post_id uuid NOT NULL,target_revision_id uuid NOT NULL,body_sha256 bytea NOT NULL,
  occurrence_id uuid NOT NULL,
  PRIMARY KEY (route,catalogue_id,stage_id,thread_id,post_id,target_revision_id,body_sha256,occurrence_id),
  FOREIGN KEY (route,catalogue_id,stage_id,occurrence_id)
    REFERENCES content.hosted_publication_staging_candidate(route,catalogue_id,stage_id,occurrence_id) ON DELETE CASCADE,
  FOREIGN KEY (route,catalogue_id,stage_id,thread_id,post_id,target_revision_id,body_sha256)
    REFERENCES content.hosted_publication_staging_target(route,catalogue_id,stage_id,thread_id,post_id,target_revision_id,body_sha256)
);
ALTER TABLE content.hosted_publication_staging_step DROP CONSTRAINT hosted_publication_staging_step_phase_check;
ALTER TABLE content.hosted_publication_staging_step ADD CONSTRAINT hosted_publication_staging_step_phase_check
  CHECK (phase IN ('whole','selection','closure','candidate_begin','candidate_page','exhausted','terminal','language_targets'));

-- A private prepared namespace becomes a public snapshot only in the pointer transaction.
CREATE TABLE content.hosted_chapter_language_namespace (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  namespace_id uuid NOT NULL,
  stage_id uuid,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','sealed','published')),
  publication_id uuid,
  PRIMARY KEY (route,catalogue_id,namespace_id),
  FOREIGN KEY (route,catalogue_id) REFERENCES content.hosted_catalogue(route,catalogue_id),
  FOREIGN KEY (route,catalogue_id,stage_id)
    REFERENCES content.hosted_publication_staging(route,catalogue_id,stage_id) ON DELETE CASCADE,
  FOREIGN KEY (route,catalogue_id,publication_id)
    REFERENCES content.hosted_structure_revision(route,catalogue_id,revision_id),
  CHECK (stage_id IS NULL OR stage_id=namespace_id),
  CHECK ((state='published' AND publication_id IS NOT NULL AND stage_id IS NULL) OR
         (state<>'published' AND publication_id IS NULL))
);
CREATE TABLE content.hosted_chapter_language_snapshot (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  namespace_id uuid NOT NULL,
  occurrence_id uuid NOT NULL,
  language text COLLATE "C" NOT NULL CHECK (length(language) BETWEEN 1 AND 63),
  first_version bigint NOT NULL CHECK (first_version >= 0),
  title text,
  title_redacted boolean NOT NULL DEFAULT false,
  target jsonb NOT NULL,
  PRIMARY KEY (route,catalogue_id,namespace_id,occurrence_id,language),
  FOREIGN KEY (route,catalogue_id,namespace_id)
    REFERENCES content.hosted_chapter_language_namespace(route,catalogue_id,namespace_id) ON DELETE CASCADE,
  FOREIGN KEY (route,catalogue_id,occurrence_id)
    REFERENCES content.hosted_occurrence(route,catalogue_id,occurrence_id),
  CHECK ((title_redacted AND title IS NULL) OR
         (NOT title_redacted AND title IS NOT NULL AND length(title) BETWEEN 1 AND 256))
);
CREATE INDEX hosted_chapter_language_snapshot_page ON content.hosted_chapter_language_snapshot
  (route,catalogue_id,namespace_id,occurrence_id,first_version,language);

CREATE FUNCTION content.hosted_language_cleanup_allowed(p_route integer,p_catalogue uuid,p_stage uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM content.hosted_publication_staging_cleanup c
    JOIN content.hosted_publication_staging s USING (route,catalogue_id,stage_id)
    WHERE c.route=p_route AND c.catalogue_id=p_catalogue AND c.stage_id=p_stage
      AND c.cleanup_active AND c.completed_at IS NULL
      AND s.status=c.terminal_status AND s.owner_epoch=c.owner_epoch AND s.sealed_at IS NULL
      AND current_setting('content.hosted_publication_staging_cleanup',true)=
          format('%s:%s:%s:%s',c.route,c.catalogue_id,c.stage_id,c.owner_epoch)
  ) OR EXISTS (
    SELECT 1 FROM content.hosted_version_candidate_cleanup c
    JOIN content.hosted_publication_staging s USING (route,catalogue_id,stage_id)
    WHERE c.route=p_route AND c.catalogue_id=p_catalogue AND c.stage_id=p_stage
      AND c.phase='generation' AND c.cleanup_active AND c.completed_at IS NULL
      AND s.status=c.terminal_status AND s.owner_epoch=c.owner_epoch AND s.sealed_at IS NOT NULL
      AND current_setting('content.hosted_version_candidate_cleanup',true)=
          format('%s:%s:%s:%s',c.route,c.catalogue_id,c.stage_id,c.generation_id)
  );
$$;

CREATE FUNCTION content.guard_hosted_language_namespace() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'open' OR NEW.publication_id IS NOT NULL THEN
      RAISE EXCEPTION 'Hosted language namespaces start private' USING ERRCODE='23514';
    END IF;
    PERFORM 1 FROM content.hosted_catalogue c JOIN content.post p
      ON p.route=c.route AND p.post_id=c.catalogue_id AND p.thread_id=c.thread_id
      WHERE c.route=NEW.route AND c.catalogue_id=NEW.catalogue_id
        AND p.availability='available' AND NOT p.author_erased FOR UPDATE OF p;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Hosted language preparation requires current native authority' USING ERRCODE='23514';
    END IF;
    IF NEW.stage_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM content.hosted_publication_staging s
      WHERE s.route=NEW.route AND s.catalogue_id=NEW.catalogue_id AND s.stage_id=NEW.stage_id
        AND s.status NOT IN ('cancelled','expired','failed','sealed') AND s.sealed_at IS NULL
    ) THEN
      RAISE EXCEPTION 'Hosted language preparation source is terminal' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.state='published' THEN
      RAISE EXCEPTION 'Published hosted language snapshots are immutable' USING ERRCODE='23514';
    END IF;
    IF OLD.stage_id IS NULL OR NOT content.hosted_language_cleanup_allowed(OLD.route,OLD.catalogue_id,OLD.stage_id)
       OR EXISTS (SELECT 1 FROM content.hosted_chapter_language_snapshot s
                  WHERE s.route=OLD.route AND s.catalogue_id=OLD.catalogue_id
                    AND s.namespace_id=OLD.namespace_id LIMIT 1) THEN
      RAISE EXCEPTION 'Private hosted namespaces require bounded native cleanup' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.route,NEW.catalogue_id,NEW.namespace_id) IS DISTINCT FROM
     ROW(OLD.route,OLD.catalogue_id,OLD.namespace_id) OR OLD.state='published' THEN
    RAISE EXCEPTION 'Hosted language namespace identity is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.state='open' AND NEW.state='sealed'
     AND NEW.stage_id IS NOT DISTINCT FROM OLD.stage_id AND NEW.publication_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.state='sealed' AND NEW.state='published' AND NEW.stage_id IS NULL
     AND EXISTS (SELECT 1 FROM content.hosted_structure_revision r
                 WHERE r.route=OLD.route AND r.catalogue_id=OLD.catalogue_id
                   AND r.revision_id=NEW.publication_id AND r.kind='publication') THEN
    PERFORM 1 FROM content.hosted_catalogue c JOIN content.post p
      ON p.route=c.route AND p.post_id=c.catalogue_id AND p.thread_id=c.thread_id
      WHERE c.route=OLD.route AND c.catalogue_id=OLD.catalogue_id
        AND p.availability='available' AND NOT p.author_erased FOR UPDATE OF p;
    IF FOUND THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'Hosted language namespace transition is not admitted' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER hosted_chapter_language_namespace_guard
  BEFORE INSERT OR UPDATE OR DELETE ON content.hosted_chapter_language_namespace
  FOR EACH ROW EXECUTE FUNCTION content.guard_hosted_language_namespace();

CREATE FUNCTION content.guard_hosted_language_title() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE namespace_state text; namespace_stage uuid;
BEGIN
  IF TG_OP='DELETE' THEN
    -- Only a private namespace's parent cascade may remove snapshot payloads.
    IF TG_TABLE_NAME='hosted_chapter_language_snapshot' THEN
      SELECT n.state,n.stage_id INTO namespace_state,namespace_stage
      FROM content.hosted_chapter_language_namespace n
      WHERE n.route=OLD.route AND n.catalogue_id=OLD.catalogue_id AND n.namespace_id=OLD.namespace_id;
      IF namespace_state IN ('open','sealed') AND namespace_stage IS NOT NULL
         AND content.hosted_language_cleanup_allowed(OLD.route,OLD.catalogue_id,namespace_stage) THEN
        RETURN OLD;
      END IF;
    END IF;
    RAISE EXCEPTION 'Hosted language identities are immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    PERFORM 1 FROM content.hosted_catalogue c JOIN content.post p
      ON p.route=c.route AND p.post_id=c.catalogue_id AND p.thread_id=c.thread_id
      WHERE c.route=NEW.route AND c.catalogue_id=NEW.catalogue_id
        AND p.availability='available' AND NOT p.author_erased FOR UPDATE OF p;
    IF NOT FOUND OR NEW.title_redacted THEN
      RAISE EXCEPTION 'Hosted language insertion requires current native authority' USING ERRCODE='23514';
    END IF;
    IF TG_TABLE_NAME='hosted_chapter_language_snapshot' THEN
      SELECT state,stage_id INTO namespace_state,namespace_stage FROM content.hosted_chapter_language_namespace
        WHERE route=NEW.route AND catalogue_id=NEW.catalogue_id AND namespace_id=NEW.namespace_id FOR UPDATE;
      IF namespace_state IS DISTINCT FROM 'open' THEN
        RAISE EXCEPTION 'Hosted language snapshot is sealed' USING ERRCODE='23514';
      END IF;
      IF namespace_stage IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM content.hosted_publication_staging s
        WHERE s.route=NEW.route AND s.catalogue_id=NEW.catalogue_id AND s.stage_id=namespace_stage
          AND s.status NOT IN ('cancelled','expired','failed','sealed') AND s.sealed_at IS NULL
      ) THEN
        RAISE EXCEPTION 'Hosted language snapshot source is terminal' USING ERRCODE='23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.title_redacted OR OLD.title IS NULL OR NOT NEW.title_redacted OR NEW.title IS NOT NULL
     OR (to_jsonb(NEW)-'title'-'title_redacted') IS DISTINCT FROM
        (to_jsonb(OLD)-'title'-'title_redacted') THEN
    RAISE EXCEPTION 'Hosted language payload permits only one-way title redaction' USING ERRCODE='23514';
  END IF;
  PERFORM 1 FROM content.hosted_catalogue c JOIN content.post p
    ON p.route=c.route AND p.post_id=c.catalogue_id AND p.thread_id=c.thread_id
    WHERE c.route=OLD.route AND c.catalogue_id=OLD.catalogue_id
      AND ((p.availability='erased' AND p.purge_started_at IS NOT NULL)
        OR (p.availability='available' AND p.visibility='published' AND p.author_erased)) FOR UPDATE OF p;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hosted language redaction requires terminal native authority' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='hosted_chapter_language_snapshot' THEN
    SELECT state INTO namespace_state FROM content.hosted_chapter_language_namespace
      WHERE route=OLD.route AND catalogue_id=OLD.catalogue_id AND namespace_id=OLD.namespace_id FOR UPDATE;
    IF namespace_state IS DISTINCT FROM 'open' AND namespace_state IS DISTINCT FROM 'sealed' THEN
      RAISE EXCEPTION 'Published hosted language titles are immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hosted_chapter_language_binding_guard
  BEFORE INSERT OR UPDATE OR DELETE ON content.hosted_chapter_language_binding
  FOR EACH ROW EXECUTE FUNCTION content.guard_hosted_language_title();
CREATE TRIGGER hosted_chapter_language_snapshot_guard
  BEFORE INSERT OR UPDATE OR DELETE ON content.hosted_chapter_language_snapshot
  FOR EACH ROW EXECUTE FUNCTION content.guard_hosted_language_title();

-- migrate:down
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM content.hosted_chapter_language_namespace WHERE state='published' LIMIT 1)
     OR EXISTS (SELECT 1 FROM content.hosted_chapter_language_binding WHERE title_redacted LIMIT 1) THEN
    RAISE EXCEPTION 'Cannot roll back retained hosted language publications or redactions' USING ERRCODE='23514';
  END IF;
END;
$$;
DROP TRIGGER hosted_chapter_language_snapshot_guard ON content.hosted_chapter_language_snapshot;
DROP TRIGGER hosted_chapter_language_binding_guard ON content.hosted_chapter_language_binding;
DROP TRIGGER hosted_chapter_language_namespace_guard ON content.hosted_chapter_language_namespace;
DROP FUNCTION content.guard_hosted_language_title();
DROP FUNCTION content.guard_hosted_language_namespace();
DROP FUNCTION content.hosted_language_cleanup_allowed(integer,uuid,uuid);
DROP TABLE content.hosted_chapter_language_snapshot;
DROP TABLE content.hosted_chapter_language_namespace;
ALTER TABLE content.hosted_publication_staging_step DROP CONSTRAINT hosted_publication_staging_step_phase_check;
ALTER TABLE content.hosted_publication_staging_step ADD CONSTRAINT hosted_publication_staging_step_phase_check
  CHECK (phase IN ('whole','selection','closure','candidate_begin','candidate_page','exhausted','terminal'));
DROP TABLE content.hosted_publication_language_target;
DROP TABLE content.hosted_publication_language_progress;
DROP INDEX content.hosted_staging_language_occurrence;
ALTER TABLE content.hosted_publication_staging_candidate DROP COLUMN body_languages;
ALTER TABLE content.hosted_publication_staging DROP COLUMN language_occurrence_count;
DROP TABLE content.hosted_chapter_language_binding;
DROP TABLE content.hosted_chapter_language_key;
DROP SEQUENCE content.hosted_chapter_language_version;
