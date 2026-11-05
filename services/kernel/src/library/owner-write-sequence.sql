UPDATE library.owner_write_counter
SET seq = seq + 1
WHERE route = :route AND account_id = :account_id
RETURNING seq;
