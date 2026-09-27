/** Access admission actions sealed by Context graph command receipts. */
export const receiptFamilies = {
  'context.create': 'context-create-v1',
  'context.change': 'context-revise-v1',
  'context.state': 'context-state-v1',
  'context.definition.state': 'context-definition-state-v1',
  'context.preference': 'context-preference-v1',
  'context.equivalence.review': 'context-definition-equivalence-v1',
  'context.select': 'context-realm-selection-v1',
  'context.rule.change': 'context-rule-v1',
  'context.rule.depend': 'context-rule-dependency-v1',
} as const;
