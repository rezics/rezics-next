-- migrate:up
CREATE TABLE economy.spot_settlement (
  book_id text NOT NULL,
  fill_id text NOT NULL CHECK (char_length(fill_id) BETWEEN 1 AND 255),
  digest bytea NOT NULL CHECK (octet_length(digest) = 32),
  base_asset_id text NOT NULL,
  base_transaction_id uuid NOT NULL,
  quote_asset_id text NOT NULL,
  quote_transaction_id uuid NOT NULL,
  CHECK (base_asset_id <> quote_asset_id),
  PRIMARY KEY (book_id, fill_id),
  FOREIGN KEY (book_id, base_asset_id, base_transaction_id)
    REFERENCES economy.journal (book_id, asset_id, transaction_id),
  FOREIGN KEY (book_id, quote_asset_id, quote_transaction_id)
    REFERENCES economy.journal (book_id, asset_id, transaction_id)
);

CREATE TRIGGER spot_settlement_immutable BEFORE UPDATE OR DELETE ON economy.spot_settlement
FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();

-- migrate:down
-- Forward only: a successful spot fill binds two immutable journal transactions.
