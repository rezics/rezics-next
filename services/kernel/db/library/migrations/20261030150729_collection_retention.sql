-- migrate:up
ALTER TABLE library.collection
  ADD COLUMN deletion_id uuid;

UPDATE library.collection
SET deletion_id = transaction_id
WHERE state = 'deleted';

ALTER TABLE library.collection
  ADD CONSTRAINT collection_deletion_id_state_check
  CHECK ((state = 'deleted') = (deletion_id IS NOT NULL));

-- migrate:down
-- Forward only: preserve exact retained deletion identity.
