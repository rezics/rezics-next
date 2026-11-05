-- migrate:up
ALTER TABLE core.receipt DROP CONSTRAINT receipt_position_check;
ALTER TABLE core.receipt
  ADD CONSTRAINT receipt_position_check CHECK ("position" >= 0);

-- migrate:down
ALTER TABLE core.receipt DROP CONSTRAINT receipt_position_check;
ALTER TABLE core.receipt
  ADD CONSTRAINT receipt_position_check CHECK ("position" > 0);
