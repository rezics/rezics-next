-- One maintainer is the Work's owner: the controller who may remove another.
-- Creation sets the flag. A later transfer moves it only when the departing
-- member is that owner. Historical rows had no flag, so the backfill below is
-- the deterministic proxy: the target of the latest transfer receipt, otherwise
-- the creator on the creation admission. When that agent is no longer a
-- maintainer, the earliest remaining member wins: smallest receipt generation
-- as target, then smallest agent IRI. A member with no receipt sorts last.
ALTER TABLE access.work_maintainer ADD COLUMN owner boolean NOT NULL DEFAULT false;

WITH latest_transfer AS (
  SELECT DISTINCT ON (work) work, target
  FROM access.work_maintainer_receipt
  WHERE action = 'transfer'
  ORDER BY work, generation DESC
),
preferred AS (
  SELECT s.work, COALESCE(t.target, a.acting_subject) AS agent
  FROM access.work_maintainer_set s
  LEFT JOIN latest_transfer t ON t.work = s.work
  LEFT JOIN access.admission a ON a.id = s.creation_admission
),
present AS (
  SELECT p.work, p.agent
  FROM preferred p
  JOIN access.work_maintainer m ON m.work = p.work AND m.agent = p.agent
),
first_seen AS (
  SELECT m.work, m.agent, MIN(r.generation) AS first_seen
  FROM access.work_maintainer m
  LEFT JOIN access.work_maintainer_receipt r ON r.work = m.work AND r.target = m.agent
  GROUP BY m.work, m.agent
),
earliest AS (
  SELECT DISTINCT ON (work) work, agent
  FROM first_seen
  ORDER BY work, first_seen ASC NULLS LAST, agent ASC
),
resolved AS (
  SELECT s.work, COALESCE(p.agent, e.agent) AS agent
  FROM access.work_maintainer_set s
  LEFT JOIN present p ON p.work = s.work
  LEFT JOIN earliest e ON e.work = s.work
)
UPDATE access.work_maintainer m
SET owner = true
FROM resolved r
WHERE m.work = r.work AND m.agent = r.agent AND r.agent IS NOT NULL;

-- At most one owner. Absence is refused by the store; a new Work's first member is the owner.
CREATE UNIQUE INDEX work_maintainer_one_owner ON access.work_maintainer (work) WHERE owner;

-- Replay of a change returns the owner that change left behind. Older receipts stay null;
-- the row is immutable, so the store resolves those from the live flag.
ALTER TABLE access.work_maintainer_receipt ADD COLUMN owner text
  CHECK (owner IS NULL OR owner ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$');
