WITH input AS NOT MATERIALIZED (SELECT :seq::bigint AS seq)
UPDATE library.entry AS entry
SET owner_write_seq = input.seq
FROM input
WHERE entry.route = :route AND entry.account_id = :account_id AND entry.subject_id = :subject_id
  AND entry.revision = :revision AND entry.transaction_id = :transaction_id
  AND input.seq > 0
  AND (entry.owner_write_seq IS NULL OR (entry.owner_write_seq > 0 AND entry.owner_write_seq < input.seq))
RETURNING entry.subject_id;
