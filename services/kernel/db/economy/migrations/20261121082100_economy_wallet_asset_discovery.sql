-- migrate:up
CREATE INDEX position_wallet_asset_page
  ON economy.position (book_id, account_id, asset_id)
  WHERE account_role = 'wallet';

CREATE INDEX pending_deposit_wallet_asset_page
  ON economy.pending_deposit (book_id, wallet_id, asset_id)
  WHERE units > 0;

-- migrate:down
DROP INDEX economy.pending_deposit_wallet_asset_page;
DROP INDEX economy.position_wallet_asset_page;
