-- migrate:up
CREATE TABLE economy.market_item (
    home_id text NOT NULL,
    item_id text NOT NULL,
    initial_holder_id text NOT NULL,
    holder_id text NOT NULL,
    generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
    marketable boolean NOT NULL,
    PRIMARY KEY (home_id, item_id)
);

CREATE TABLE economy.market_item_listing (
    home_id text NOT NULL,
    book_id text NOT NULL,
    listing_id text NOT NULL,
    item_id text NOT NULL,
    holder_id text NOT NULL,
    generation bigint NOT NULL CHECK (generation > 0),
    reservation_id text NOT NULL,
    protected_until bigint NOT NULL CHECK (protected_until > 0),
    phase text NOT NULL CHECK (phase IN ('reserved', 'prepared', 'fenced', 'released', 'delivered')),
    trade_id text,
    PRIMARY KEY (home_id, book_id, listing_id),
    UNIQUE (home_id, item_id, reservation_id),
    FOREIGN KEY (home_id, item_id) REFERENCES economy.market_item (home_id, item_id),
    CHECK (phase <> 'reserved' OR trade_id IS NULL),
    CHECK (phase NOT IN ('prepared', 'fenced', 'delivered') OR trade_id IS NOT NULL)
);

CREATE UNIQUE INDEX market_one_active_item_listing
    ON economy.market_item_listing (home_id, item_id) WHERE phase IN ('reserved', 'prepared', 'fenced');

CREATE TABLE economy.market_item_trade (
    home_id text NOT NULL,
    book_id text NOT NULL,
    trade_id text NOT NULL,
    listing_id text NOT NULL,
    binding jsonb NOT NULL CHECK (jsonb_typeof(binding) = 'object'),
    phase text NOT NULL CHECK (phase IN ('prepared', 'fenced', 'released', 'delivered')),
    decided_at bigint CHECK (decided_at >= 0),
    PRIMARY KEY (home_id, book_id, trade_id),
    FOREIGN KEY (home_id, book_id, listing_id) REFERENCES economy.market_item_listing (home_id, book_id, listing_id),
    CHECK ((phase = 'prepared') = (decided_at IS NULL))
);

CREATE TABLE economy.market_item_receipt (
    home_id text NOT NULL,
    book_id text NOT NULL,
    instruction_id text NOT NULL,
    work jsonb NOT NULL CHECK (jsonb_typeof(work) = 'object'),
    receipt_id uuid NOT NULL,
    observed_generation bigint CHECK (observed_generation > 0),
    PRIMARY KEY (home_id, book_id, instruction_id)
);

CREATE TRIGGER market_item_receipt_immutable BEFORE UPDATE OR DELETE ON economy.market_item_receipt
    FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();

-- migrate:down
-- Forward only: stable ownership, abort fences and delivery receipts survive upgrade.
