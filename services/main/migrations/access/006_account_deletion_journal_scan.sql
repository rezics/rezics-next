-- The separate relay journal scans only Account deletion intents in UUID order.
CREATE INDEX access_outbox_account_deletion_cursor ON access.outbox (id)
    WHERE kind = 'account.deletion_fenced';
