-- migrate:up
-- Stored block IDs derive from the guarded canonical bytes after the BEFORE trigger.
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
            AND ROW(NEW.route, NEW.document_id, NEW.revision_id, NEW.title, NEW.language, NEW.canonical_bytes,
                    NEW.body_sha256, NEW.licence, NEW.subject_ids, NEW.recorded_transaction_id, NEW.created_at,
                    NEW.reference_manifest, NEW.media_ids) IS NOT DISTINCT FROM
                ROW(OLD.route, OLD.document_id, OLD.revision_id, OLD.title, OLD.language, OLD.canonical_bytes,
                    OLD.body_sha256, OLD.licence, OLD.subject_ids, OLD.recorded_transaction_id, OLD.created_at,
                    OLD.reference_manifest, OLD.media_ids)
          THEN RETURN NEW; END IF;
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

-- migrate:down
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
