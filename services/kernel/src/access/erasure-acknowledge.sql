WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id,
         :participant::text AS participant, :outcome::text AS outcome
), inserted AS (
  INSERT INTO access.erasure_acknowledgement (route, account_id, participant, outcome)
  SELECT route, account_id, participant, outcome FROM input
  ON CONFLICT (route, account_id, participant) DO NOTHING
  RETURNING outcome
)
SELECT outcome, true AS inserted FROM inserted
UNION ALL
SELECT a.outcome, false AS inserted FROM access.erasure_acknowledgement a CROSS JOIN input i
WHERE a.route = i.route AND a.account_id = i.account_id AND a.participant = i.participant
  AND NOT EXISTS (SELECT 1 FROM inserted);
