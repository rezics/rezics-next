-- migrate:up
CREATE INDEX board_global_directory_page ON content.board (route, board_id)
WHERE realm_id IS NULL AND visibility = 'published';
CREATE INDEX board_global_directory_purpose_page ON content.board (purpose, route, board_id)
WHERE realm_id IS NULL AND visibility = 'published';

-- migrate:down
DROP INDEX content.board_global_directory_purpose_page;
DROP INDEX content.board_global_directory_page;
