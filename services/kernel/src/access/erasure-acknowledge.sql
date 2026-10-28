WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id,
         :participant::text AS participant, :outcome::text AS outcome, :retained::jsonb AS retained
), inserted AS (
  INSERT INTO access.erasure_acknowledgement (route, account_id, participant, outcome, retained)
  SELECT route, account_id, participant, outcome, retained FROM input
  ON CONFLICT (route, account_id, participant) DO NOTHING
  RETURNING outcome, retained
)
SELECT outcome, retained, true AS inserted FROM inserted
UNION ALL
SELECT a.outcome, a.retained, false AS inserted FROM access.erasure_acknowledgement a CROSS JOIN input i
WHERE a.route = i.route AND a.account_id = i.account_id AND a.participant = i.participant
  AND NOT EXISTS (SELECT 1 FROM inserted);
