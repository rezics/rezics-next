-- migrate:up
ALTER TABLE content.board_thread
  DROP CONSTRAINT board_thread_pin_slot_check,
  ADD CONSTRAINT board_thread_pin_slot_check
    CHECK (pin_slot IS NULL OR pin_slot BETWEEN 1 AND 5);

-- Separate from security revisions and feed/rank watermarks. The board row lock
-- serializes every effective pin mutation and its observation counter.
ALTER TABLE content.board
  ADD COLUMN pin_revision bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT board_pin_revision_check CHECK (pin_revision >= 0);

-- migrate:down
-- Forward only: existing pins and continuation observations must remain valid.
