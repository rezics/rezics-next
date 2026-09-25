-- A sent private result cannot be cancelled by a timeout or socket close: the
-- peer may still consume bytes buffered before that event. Arm this marker in
-- Access before calling the transport's send operation. Only a matched receipt
-- may then finish the delivery; uncertain rows remain visible and pending.
ALTER TABLE access.search_read_lease
    ADD COLUMN send_started_at timestamptz,
    ADD COLUMN receipt_digest text;

ALTER TABLE access.search_read_lease
    ADD CONSTRAINT search_read_receipt_pair CHECK (
      (send_started_at IS NULL AND receipt_digest IS NULL)
      OR (send_started_at IS NOT NULL AND receipt_digest ~ '^[0-9a-f]{64}$')
    ),
    ADD CONSTRAINT search_read_terminal_send CHECK (
      (state IN ('admitted', 'aborted', 'expired') AND send_started_at IS NULL)
      OR state = 'delivering'
      OR (state = 'delivered' AND send_started_at IS NOT NULL)
    );
