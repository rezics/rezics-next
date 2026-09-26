-- One adopting proposal revision can reserve one execution operation. A stale
-- expected target requires a new proposal revision rather than a second effect.
CREATE UNIQUE INDEX proposal_execution_revision_once
  ON access.proposal_execution_admission (proposal_revision);
