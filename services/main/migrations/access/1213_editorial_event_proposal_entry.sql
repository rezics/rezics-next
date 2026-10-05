-- The proposal timeline pages by immutable entry (G-1200); keep that keyset read indexed.
CREATE INDEX IF NOT EXISTS editorial_event_proposal_entry ON access.editorial_event (proposal, entry);
