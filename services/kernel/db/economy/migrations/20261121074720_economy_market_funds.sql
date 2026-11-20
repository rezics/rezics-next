-- migrate:up
CREATE TABLE economy.market_funds_trade (
    book_id text NOT NULL,
    trade_id text NOT NULL,
    binding jsonb NOT NULL CHECK (jsonb_typeof(binding) = 'object'),
    escrow_id uuid NOT NULL,
    funded boolean NOT NULL,
    phase text NOT NULL CHECK (phase IN ('prepared', 'fenced', 'released', 'escrowed', 'settled')),
    decided_at bigint CHECK (decided_at >= 0),
    PRIMARY KEY (book_id, trade_id),
    UNIQUE (book_id, escrow_id),
    CHECK ((phase = 'prepared') = (decided_at IS NULL)),
    CHECK (funded OR phase IN ('fenced', 'released'))
);

CREATE TABLE economy.market_funds_receipt (
    book_id text NOT NULL,
    instruction_id text NOT NULL,
    trade_id text NOT NULL,
    work jsonb NOT NULL CHECK (jsonb_typeof(work) = 'object'),
    receipt_id uuid NOT NULL,
    PRIMARY KEY (book_id, instruction_id),
    FOREIGN KEY (book_id, trade_id) REFERENCES economy.market_funds_trade (book_id, trade_id)
);

CREATE TRIGGER market_funds_receipt_immutable BEFORE UPDATE OR DELETE ON economy.market_funds_receipt
    FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();

-- migrate:down
-- Forward only: protected escrow, abort fences and ledger receipts survive upgrade.
