-- Widen the receipt action check from 370, keeping create, add and transfer.
ALTER TABLE access.work_maintainer_receipt DROP CONSTRAINT work_maintainer_receipt_action_check;
ALTER TABLE access.work_maintainer_receipt ADD CONSTRAINT work_maintainer_receipt_action_check
  CHECK (action IN ('create', 'add', 'transfer', 'remove'));
