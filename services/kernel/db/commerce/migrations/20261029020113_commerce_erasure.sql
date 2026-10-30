-- migrate:up
-- Native local ownership probes. Foreign/shared custody remains unproven.
CREATE INDEX offer_erasure_owner ON commerce.offer (route, creator_account_id, offer_id);
CREATE INDEX purchase_order_erasure_buyer ON commerce.purchase_order (route, buyer_account_id, order_id);
CREATE INDEX royalty_line_erasure_creator ON commerce.royalty_line (route, creator_account_id, balance_transaction_id);
CREATE TABLE commerce.erasure_progress (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  had_data boolean NOT NULL,
  cursor_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  phase text NOT NULL DEFAULT 'entitlements' CHECK (phase IN ('entitlements', 'pending')),
  blocker text,
  PRIMARY KEY (route, account_id)
);

-- migrate:down
DROP TABLE commerce.erasure_progress;
DROP INDEX commerce.royalty_line_erasure_creator;
DROP INDEX commerce.purchase_order_erasure_buyer;
DROP INDEX commerce.offer_erasure_owner;
