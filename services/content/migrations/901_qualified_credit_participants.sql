-- Existing immutable intents retain their exact digest and implicit qualification.
-- New intents record qualification independently of provider role evidence.
ALTER TABLE source.author_credit_intent
  DROP CONSTRAINT author_credit_intent_source_key_check,
  ADD CONSTRAINT author_credit_intent_source_key_check CHECK
    (length(source_key) BETWEEN 1 AND 200 AND source_key !~ '[[:cntrl:]]'),
  ADD COLUMN source_provider text,
  ADD COLUMN source_namespace text,
  ADD COLUMN credit_role text,
  ADD CONSTRAINT author_credit_qualification CHECK (
    (source_provider IS NULL AND source_namespace IS NULL AND credit_role IS NULL) OR
    (source_provider IS NOT NULL AND source_namespace IS NOT NULL AND credit_role IS NOT NULL
      AND source_provider ~ '^[a-z][a-z0-9-]{0,63}$' AND source_namespace ~ '^[a-z][a-z0-9-]{0,63}$'
      AND credit_role IN ('author','translator','editor','director','artist','animation-studio')));
