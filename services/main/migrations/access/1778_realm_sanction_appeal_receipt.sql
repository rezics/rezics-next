-- An appeal is final for one sanction. A later sanction is a new receipt, and the
-- appeal row is immutable, so one receipt can have only one appeal. The earlier
-- (receipt, opened_at) index is redundant once receipt_id is unique.
DROP INDEX access.realm_sanction_appeal_receipt;
CREATE UNIQUE INDEX realm_sanction_appeal_receipt ON access.realm_sanction_appeal (receipt_id);
