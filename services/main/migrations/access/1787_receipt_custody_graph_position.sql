-- Stored generation backfills retained (including erased) outboxes without
-- mutating their immutable terminals. Reconciliation writes this position in
-- the same statement as the owner's outbox, with no independently writable copy.
ALTER TABLE access.command_custody
  ADD COLUMN graph_sequence numeric(100,0)
    GENERATED ALWAYS AS ((outbox->>'graphSequence')::numeric(100,0)) STORED,
  ADD CONSTRAINT command_custody_graph_position CHECK (
    (terminal IS NULL) = (graph_sequence IS NULL)
    AND (graph_sequence IS NULL OR graph_sequence > 0)
  );

CREATE UNIQUE INDEX command_custody_graph_position
  ON access.command_custody (data_epoch, graph_sequence);
