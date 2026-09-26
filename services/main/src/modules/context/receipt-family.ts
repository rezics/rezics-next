/** Access admission actions sealed by Context graph command receipts. */
export const receiptFamilies = {
  'context.create': 'context-create-v1',
  'context.change': 'context-revise-v1',
  'context.select': 'context-realm-selection-v1',
} as const;
