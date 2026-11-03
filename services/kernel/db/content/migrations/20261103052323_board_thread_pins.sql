-- migrate:up
ALTER TABLE content.board_thread
  ADD COLUMN pin_slot smallint,
  ADD CONSTRAINT board_thread_pin_slot_check
    CHECK (pin_slot IS NULL OR pin_slot BETWEEN 1 AND 3);

CREATE UNIQUE INDEX board_thread_pin_position_idx
  ON content.board_thread (route, board_id, pin_slot) INCLUDE (thread_id)
  WHERE pin_slot IS NOT NULL;

-- migrate:down
-- Forward only: retained board thread pins are part of the native board projection.
