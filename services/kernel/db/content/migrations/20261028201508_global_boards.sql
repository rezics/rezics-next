-- migrate:up
-- Global Context has no scheme mapping a concept or purpose to one board.
DROP INDEX content.board_one_global_reviews_idx;

-- migrate:down
-- Forward only: multiple Global reviews boards must survive rollback.
