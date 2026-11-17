-- migrate:up
ALTER TABLE content.media ADD COLUMN reservation_board_id uuid;

-- migrate:down
ALTER TABLE content.media DROP COLUMN reservation_board_id;
