-- migrate:up
CREATE TABLE content.board_slow_mode (
    route integer NOT NULL,
    board_id uuid NOT NULL,
    interval_seconds integer NOT NULL CHECK (interval_seconds BETWEEN 0 AND 86400),
    PRIMARY KEY (route, board_id),
    FOREIGN KEY (route, board_id) REFERENCES content.board(route, board_id) ON DELETE CASCADE
);

-- Native posting coordination: one key shared by every content route for this board/actor.
-- The opaque actor key stores no account identity or request key.
CREATE TABLE content.board_slow_actor (
    route integer NOT NULL,
    board_id uuid NOT NULL,
    actor_key bytea NOT NULL CHECK (octet_length(actor_key) = 32),
    posted_at timestamptz NOT NULL,
    PRIMARY KEY (route, board_id, actor_key),
    FOREIGN KEY (route, board_id) REFERENCES content.board(route, board_id) ON DELETE CASCADE
);

-- migrate:down
DROP TABLE content.board_slow_actor;
DROP TABLE content.board_slow_mode;
