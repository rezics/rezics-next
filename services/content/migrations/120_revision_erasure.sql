-- Non-sensitive owner tombstone for a Content revision erased under the relay
-- erasure journal (relay 010). It keeps only the journal identity and epoch so
-- replay, rebuild and restore reconciliation can reject stale events without the
-- erased bytes. content.revision.availability remains the read state; this row
-- commits only together with that revision's transition to erased.
CREATE TABLE content.revision_erasure (
  revision_id uuid PRIMARY KEY REFERENCES content.revision(id),
  erasure_id uuid NOT NULL,
  erasure_epoch bigint NOT NULL CHECK (erasure_epoch >= 1),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX revision_erasure_epoch_idx ON content.revision_erasure (erasure_epoch, revision_id);
CREATE INDEX revision_erasure_journal_idx ON content.revision_erasure (erasure_id, revision_id);
CREATE TRIGGER revision_erasure_immutable BEFORE UPDATE OR DELETE ON content.revision_erasure
  FOR EACH ROW EXECUTE FUNCTION content.no_mutation();

CREATE FUNCTION content.revision_erasure_applied() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM content.revision
                 WHERE id = NEW.revision_id AND availability = 'erased') THEN
    RAISE EXCEPTION 'Content erasure tombstone requires an erased revision' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER revision_erasure_applied AFTER INSERT ON content.revision_erasure
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION content.revision_erasure_applied();
