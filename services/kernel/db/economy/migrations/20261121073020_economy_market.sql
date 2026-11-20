-- migrate:up
CREATE TABLE economy.market_listing (
    book_id text NOT NULL,
    listing_id text NOT NULL,
    item_home_id text NOT NULL,
    item_id text NOT NULL,
    reservation_id text NOT NULL,
    revision bigint NOT NULL CHECK (revision >= 0),
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    PRIMARY KEY (book_id, listing_id),
    UNIQUE (book_id, item_home_id, item_id, reservation_id)
);

CREATE TABLE economy.market_trade (
    book_id text NOT NULL,
    trade_id text NOT NULL,
    listing_id text NOT NULL,
    revision bigint NOT NULL CHECK (revision >= 0),
    prepare_until bigint NOT NULL CHECK (prepare_until > 0),
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    decision_pending boolean GENERATED ALWAYS AS (payload -> 'decision' = 'null'::jsonb) STORED NOT NULL,
    prepared boolean GENERATED ALWAYS AS ((payload -> 'receipts') ?& ARRAY['prepare_item', 'prepare_funds']) STORED NOT NULL,
    PRIMARY KEY (book_id, trade_id),
    UNIQUE (book_id, listing_id),
    FOREIGN KEY (book_id, listing_id) REFERENCES economy.market_listing (book_id, listing_id)
);

CREATE INDEX market_trade_pending_decision
    ON economy.market_trade (book_id, prepare_until, trade_id) WHERE decision_pending;
CREATE INDEX market_trade_prepared_decision
    ON economy.market_trade (book_id, prepare_until, trade_id) WHERE decision_pending AND prepared;

CREATE TABLE economy.market_work (
    book_id text NOT NULL,
    instruction_id text NOT NULL,
    listing_id text NOT NULL,
    trade_id text,
    owner_kind text NOT NULL CHECK (owner_kind IN ('item', 'ledger')),
    owner_id text NOT NULL,
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'acknowledged', 'superseded')),
    claim_id uuid,
    available_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    receipt jsonb,
    PRIMARY KEY (book_id, instruction_id),
    FOREIGN KEY (book_id, listing_id) REFERENCES economy.market_listing (book_id, listing_id),
    FOREIGN KEY (book_id, trade_id) REFERENCES economy.market_trade (book_id, trade_id),
    CHECK ((status = 'acknowledged') = (receipt IS NOT NULL)),
    CHECK (status <> 'acknowledged' OR claim_id IS NOT NULL),
    CHECK (receipt IS NULL OR jsonb_typeof(receipt) = 'object')
);

CREATE INDEX market_work_ready
    ON economy.market_work (book_id, owner_kind, owner_id, available_at, instruction_id)
    WHERE status = 'pending';
CREATE INDEX market_work_by_trade ON economy.market_work (book_id, trade_id);

-- migrate:down
-- Forward only: listing, settlement decisions and owner acknowledgments survive upgrade.
