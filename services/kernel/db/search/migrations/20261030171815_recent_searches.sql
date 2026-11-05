-- migrate:up
CREATE TABLE search.recent_search_state (
    partition_no integer NOT NULL,
    route integer NOT NULL,
    account_id uuid NOT NULL,
    revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
    PRIMARY KEY (partition_no, route, account_id),
    CHECK (partition_no = (route >> 4))
);
CREATE TABLE search.recent_search (
    partition_no integer NOT NULL,
    route integer NOT NULL,
    account_id uuid NOT NULL,
    id uuid NOT NULL,
    entry jsonb NOT NULL CHECK (octet_length(entry::text) <= 4096),
    entry_key text NOT NULL,
    last_used timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    revision integer NOT NULL CHECK (revision > 0),
    PRIMARY KEY (partition_no, route, account_id, id),
    UNIQUE (partition_no, route, account_id, entry_key),
    FOREIGN KEY (partition_no, route, account_id) REFERENCES search.recent_search_state ON DELETE CASCADE,
    CHECK (partition_no = (route >> 4))
);
CREATE INDEX recent_search_page ON search.recent_search
    (partition_no, route, account_id, last_used DESC, id DESC);
CREATE INDEX recent_search_expiry ON search.recent_search (partition_no, expires_at, route, account_id, id);

-- migrate:down
DROP TABLE search.recent_search;
DROP TABLE search.recent_search_state;
