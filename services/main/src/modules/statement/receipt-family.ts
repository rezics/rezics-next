/** Access admission actions sealed by Statement graph command receipts. */
export const receiptFamilies = {
  'statement.record': 'statement-record-v1',
  'statement.withdraw': 'statement-withdraw-v1',
  'statement.decide': 'statement-decision-v1',
  'statement.migrate': 'statement-migrate-v1',
  'statement.cutover': 'statement-cutover-v1',
} as const;
