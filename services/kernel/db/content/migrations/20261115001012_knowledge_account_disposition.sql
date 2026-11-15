-- migrate:up
ALTER TABLE content.knowledge_notebook ADD COLUMN account_erased boolean NOT NULL DEFAULT false;
ALTER TABLE content.knowledge_document
  ADD COLUMN account_erased boolean NOT NULL DEFAULT false,
  ADD COLUMN retained_public_generation bigint CHECK (retained_public_generation IS NULL OR retained_public_generation>=0),
  ALTER COLUMN notebook_id DROP NOT NULL,
  ALTER COLUMN head_revision_id DROP NOT NULL,
  ALTER COLUMN created_transaction_id DROP NOT NULL,
  ALTER COLUMN created_at DROP NOT NULL,
  ADD CONSTRAINT knowledge_document_active_identity CHECK (
    account_erased OR (notebook_id IS NOT NULL AND head_revision_id IS NOT NULL
      AND created_transaction_id IS NOT NULL AND created_at IS NOT NULL)
  );
CREATE INDEX knowledge_notebook_erasure_owner ON content.knowledge_notebook(route,owner_account_id,notebook_id);
CREATE INDEX knowledge_document_hold ON content.knowledge_document(route,notebook_id,document_id) WHERE legal_hold;

CREATE OR REPLACE FUNCTION content.knowledge_document_eligible(
  selected_route integer,selected_document uuid,include_trashed_target boolean DEFAULT false
) RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH RECURSIVE retained AS (
    SELECT 1 FROM content.knowledge_document d
    JOIN content.knowledge_publication p
      ON p.route=d.route AND p.document_id=d.document_id AND p.publication_id=d.current_publication_id
     AND p.lifecycle_generation=d.lifecycle_generation
    JOIN content.knowledge_publication_selection s
      ON s.route=p.route AND s.document_id=p.document_id AND s.lifecycle_generation=p.lifecycle_generation
     AND s.revision_id=p.revision_id AND s.publication_id=p.publication_id
    WHERE d.route=selected_route AND d.document_id=selected_document AND d.account_erased
      AND d.retained_public_generation=d.lifecycle_generation AND d.deleted_at IS NULL
      AND d.purge_started_at IS NULL AND NOT d.purge_completed
  ), path AS (
    SELECT p.notebook_id,p.placement_id,p.parent_id,0 AS depth,
      (d.deleted_at IS NULL OR include_trashed_target) AND d.purge_started_at IS NULL AND NOT d.purge_completed AS eligible
    FROM content.knowledge_document d
    JOIN content.knowledge_notebook n ON n.route=d.route AND n.notebook_id=d.notebook_id AND NOT n.account_erased
    JOIN content.knowledge_placement p ON p.route=d.route AND p.notebook_id=d.notebook_id AND p.document_id=d.document_id
    WHERE d.route=selected_route AND d.document_id=selected_document AND NOT d.account_erased
    UNION ALL
    SELECT p.notebook_id,p.placement_id,p.parent_id,child.depth+1,
      d.deleted_at IS NULL AND d.purge_started_at IS NULL AND NOT d.purge_completed
    FROM path child
    JOIN content.knowledge_placement p
      ON p.route=selected_route AND p.notebook_id=child.notebook_id AND p.placement_id=child.parent_id
    JOIN content.knowledge_document d ON d.route=p.route AND d.notebook_id=p.notebook_id AND d.document_id=p.document_id
    WHERE child.depth<31
  )
  SELECT EXISTS(SELECT 1 FROM retained) OR COALESCE(bool_and(eligible) AND bool_or(parent_id IS NULL),false) FROM path;
$$;

CREATE FUNCTION content.guard_knowledge_account_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.account_erased THEN RAISE EXCEPTION 'Knowledge erasure requires existing native ownership' USING ERRCODE='23514'; END IF;
    IF TG_TABLE_NAME='knowledge_document' THEN
      PERFORM 1 FROM content.knowledge_notebook n
      WHERE n.route=NEW.route AND n.notebook_id=NEW.notebook_id AND NOT n.account_erased FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Knowledge notebook is terminal' USING ERRCODE='23514'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.account_erased AND NOT NEW.account_erased THEN
    RAISE EXCEPTION 'Knowledge account disposition is irreversible' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='knowledge_notebook' AND OLD.account_erased AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Knowledge notebook disposition is terminal' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='knowledge_document' AND OLD.account_erased THEN
    IF (OLD.notebook_id IS NULL AND NEW.notebook_id IS NOT NULL)
      OR NEW.lifecycle_generation<OLD.lifecycle_generation
      OR OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL AND NEW.purge_started_at IS NULL
      OR (NEW.notebook_id IS NOT NULL AND NEW.notebook_id IS DISTINCT FROM OLD.notebook_id)
      OR NEW.head_revision_id IS DISTINCT FROM OLD.head_revision_id AND NEW.head_revision_id IS NOT NULL
      OR NEW.current_publication_id IS DISTINCT FROM OLD.current_publication_id AND NEW.current_publication_id IS NOT NULL
      OR OLD.purge_started_at IS NOT NULL AND NEW.purge_started_at IS NULL
      OR OLD.purge_completed AND NOT NEW.purge_completed
      OR NEW.retained_public_generation IS DISTINCT FROM OLD.retained_public_generation AND NEW.retained_public_generation IS NOT NULL THEN
      RAISE EXCEPTION 'Knowledge account disposition cannot restore private or public state' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER knowledge_notebook_account_fence BEFORE INSERT OR UPDATE ON content.knowledge_notebook
  FOR EACH ROW EXECUTE FUNCTION content.guard_knowledge_account_fence();
CREATE TRIGGER knowledge_document_account_fence BEFORE INSERT OR UPDATE ON content.knowledge_document
  FOR EACH ROW EXECUTE FUNCTION content.guard_knowledge_account_fence();

CREATE OR REPLACE FUNCTION content.guard_knowledge_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source content.knowledge_document%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='knowledge_structure_revision' THEN
    IF TG_OP='DELETE' AND EXISTS (
      SELECT 1 FROM content.knowledge_notebook n WHERE n.route=OLD.route AND n.notebook_id=OLD.notebook_id AND n.account_erased
    ) THEN RETURN OLD; END IF;
    IF TG_OP='INSERT' AND EXISTS (
      SELECT 1 FROM content.knowledge_notebook n WHERE n.route=NEW.route AND n.notebook_id=NEW.notebook_id AND NOT n.account_erased
    ) THEN RETURN NEW; END IF;
  ELSE
    IF TG_OP='INSERT' THEN
      PERFORM 1 FROM content.knowledge_document d JOIN content.knowledge_notebook n
        ON n.route=d.route AND n.notebook_id=d.notebook_id
      WHERE d.route=NEW.route AND d.document_id=NEW.document_id AND NOT d.account_erased AND NOT n.account_erased
      FOR SHARE OF n,d;
      IF FOUND THEN RETURN NEW; END IF;
    ELSE
      SELECT * INTO source FROM content.knowledge_document d
      WHERE d.route=OLD.route AND d.document_id=OLD.document_id FOR UPDATE;
      IF source.account_erased AND NOT source.legal_hold THEN
        IF TG_TABLE_NAME='knowledge_revision' AND TG_OP='UPDATE' THEN
          IF NEW.author_account_id IS NULL
            AND (NEW.copy_provenance IS NULL OR NEW.copy_provenance=OLD.copy_provenance AND NEW.copy_provenance->>'representation'='public')
            AND (to_jsonb(NEW)-'author_account_id'-'copy_provenance') IS NOT DISTINCT FROM
                (to_jsonb(OLD)-'author_account_id'-'copy_provenance') THEN RETURN NEW; END IF;
        END IF;
        IF TG_OP='DELETE' AND NOT EXISTS (
          SELECT 1 FROM content.knowledge_publication_selection s
          WHERE s.route=source.route AND s.document_id=source.document_id
            AND s.lifecycle_generation=source.retained_public_generation
            AND s.lifecycle_generation=source.lifecycle_generation
            AND s.revision_id=OLD.revision_id
            AND (TG_TABLE_NAME='knowledge_revision' OR s.publication_id=(to_jsonb(OLD)->>'publication_id')::uuid)
        ) THEN RETURN OLD; END IF;
      END IF;
    END IF;
  END IF;
  RAISE EXCEPTION 'Knowledge revisions and publications are immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER knowledge_revision_terminal_insert BEFORE INSERT ON content.knowledge_revision
  FOR EACH ROW EXECUTE FUNCTION content.guard_knowledge_snapshot();
CREATE TRIGGER knowledge_publication_terminal_insert BEFORE INSERT ON content.knowledge_publication
  FOR EACH ROW EXECUTE FUNCTION content.guard_knowledge_snapshot();
CREATE TRIGGER knowledge_structure_revision_terminal_insert BEFORE INSERT ON content.knowledge_structure_revision
  FOR EACH ROW EXECUTE FUNCTION content.guard_knowledge_snapshot();

CREATE OR REPLACE FUNCTION content.guard_knowledge_structure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM 1 FROM content.knowledge_notebook n
    WHERE n.route=NEW.route AND n.notebook_id=NEW.notebook_id AND NOT n.account_erased FOR SHARE;
    IF FOUND THEN RETURN NEW; END IF;
  ELSIF EXISTS (
    SELECT 1 FROM content.knowledge_notebook n WHERE n.route=OLD.route AND n.notebook_id=OLD.notebook_id AND n.account_erased
  ) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    IF TG_TABLE_NAME='knowledge_structure_page' THEN
      IF NEW.left_page_id IS NULL AND NEW.right_page_id IS NULL
        AND (to_jsonb(NEW)-'left_page_id'-'right_page_id') IS NOT DISTINCT FROM
            (to_jsonb(OLD)-'left_page_id'-'right_page_id') THEN RETURN NEW; END IF;
    END IF;
  END IF;
  RAISE EXCEPTION 'Knowledge structure revisions are immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER knowledge_structure_page_terminal_insert BEFORE INSERT ON content.knowledge_structure_page
  FOR EACH ROW EXECUTE FUNCTION content.guard_knowledge_structure();
CREATE TRIGGER knowledge_structure_root_terminal_insert BEFORE INSERT ON content.knowledge_structure_parent_root
  FOR EACH ROW EXECUTE FUNCTION content.guard_knowledge_structure();
CREATE TRIGGER knowledge_structure_change_terminal_insert BEFORE INSERT ON content.knowledge_structure_change
  FOR EACH ROW EXECUTE FUNCTION content.guard_knowledge_structure();

-- migrate:down
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM content.knowledge_document WHERE account_erased LIMIT 1)
    OR EXISTS(SELECT 1 FROM content.knowledge_notebook WHERE account_erased LIMIT 1) THEN
    RAISE EXCEPTION 'Cannot roll back retained Knowledge account disposition' USING ERRCODE='23514';
  END IF;
END; $$;
DROP TRIGGER knowledge_structure_change_terminal_insert ON content.knowledge_structure_change;
DROP TRIGGER knowledge_structure_root_terminal_insert ON content.knowledge_structure_parent_root;
DROP TRIGGER knowledge_structure_page_terminal_insert ON content.knowledge_structure_page;
DROP TRIGGER knowledge_structure_revision_terminal_insert ON content.knowledge_structure_revision;
DROP TRIGGER knowledge_publication_terminal_insert ON content.knowledge_publication;
DROP TRIGGER knowledge_revision_terminal_insert ON content.knowledge_revision;
DROP TRIGGER knowledge_document_account_fence ON content.knowledge_document;
DROP TRIGGER knowledge_notebook_account_fence ON content.knowledge_notebook;
DROP FUNCTION content.guard_knowledge_account_fence();
CREATE OR REPLACE FUNCTION content.knowledge_document_eligible(
  selected_route integer,selected_document uuid,include_trashed_target boolean DEFAULT false
) RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH RECURSIVE path AS (
    SELECT p.notebook_id,p.placement_id,p.parent_id,0 AS depth,
      (d.deleted_at IS NULL OR include_trashed_target) AND d.purge_started_at IS NULL AND NOT d.purge_completed AS eligible
    FROM content.knowledge_document d
    JOIN content.knowledge_placement p ON p.route=d.route AND p.notebook_id=d.notebook_id AND p.document_id=d.document_id
    WHERE d.route=selected_route AND d.document_id=selected_document
    UNION ALL
    SELECT p.notebook_id,p.placement_id,p.parent_id,child.depth+1,
      d.deleted_at IS NULL AND d.purge_started_at IS NULL AND NOT d.purge_completed
    FROM path child
    JOIN content.knowledge_placement p ON p.route=selected_route AND p.notebook_id=child.notebook_id AND p.placement_id=child.parent_id
    JOIN content.knowledge_document d ON d.route=p.route AND d.notebook_id=p.notebook_id AND d.document_id=p.document_id
    WHERE child.depth<31
  ) SELECT COALESCE(bool_and(eligible) AND bool_or(parent_id IS NULL),false) FROM path;
$$;
CREATE OR REPLACE FUNCTION content.guard_knowledge_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Knowledge revisions and publications are immutable' USING ERRCODE='23514'; END; $$;
CREATE OR REPLACE FUNCTION content.guard_knowledge_structure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Knowledge structure revisions are immutable' USING ERRCODE='23514'; END; $$;
ALTER TABLE content.knowledge_document
  DROP CONSTRAINT knowledge_document_active_identity,
  DROP COLUMN retained_public_generation,DROP COLUMN account_erased,
  ALTER COLUMN notebook_id SET NOT NULL,ALTER COLUMN head_revision_id SET NOT NULL,
  ALTER COLUMN created_transaction_id SET NOT NULL,ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE content.knowledge_notebook DROP COLUMN account_erased;
DROP INDEX content.knowledge_notebook_erasure_owner;
DROP INDEX content.knowledge_document_hold;
