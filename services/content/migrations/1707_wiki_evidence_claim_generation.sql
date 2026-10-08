-- A claim binding is the only Content change that discloses already-published
-- evidence for a graph Statement. It must expire reader continuations in the
-- binding's own transaction, through the existing epoch-aware, once-per-transaction
-- change signal. The WHEN clause keeps the guarded, once-only bind the sole trigger.
CREATE TRIGGER wiki_evidence_claim_generation AFTER UPDATE OF claim ON wiki.evidence
  FOR EACH ROW WHEN (OLD.claim IS NULL AND NEW.claim IS NOT NULL)
  EXECUTE FUNCTION reading_position.advance_generation();

-- Continuations minted before this migration cannot know about binds that
-- landed without a signal. One change row, written like the trigger writes it,
-- retires them; the restore epoch and every custody marker are left alone.
INSERT INTO reading_position.change(data_epoch,epoch)
  SELECT o.data_epoch,g.version FROM content.owner_control o
    CROSS JOIN reading_position.generation g WHERE o.singleton AND g.singleton;
