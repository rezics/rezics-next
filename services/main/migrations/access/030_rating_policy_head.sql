-- The private sealed head witnesses the public graph default at one Context.
-- Existing contexts require explicit reconstruction before default reads.
ALTER TABLE access.rating_aggregate_context
  ADD COLUMN policy_revision text;
