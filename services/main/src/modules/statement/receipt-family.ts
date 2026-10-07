/** One source for the families used by Statement commands and Access admission sealing. */
export const STATEMENT_FAMILIES = {
  record: 'statement-record-v1',
  withdraw: 'statement-withdraw-v1',
  decide: 'statement-decision-v1',
} as const;

export const receiptFamilies = {
  'statement.record': STATEMENT_FAMILIES.record,
  'statement.withdraw': STATEMENT_FAMILIES.withdraw,
  'statement.decide': STATEMENT_FAMILIES.decide,
} as const;
