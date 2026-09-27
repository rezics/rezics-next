import type { CaseDeclarations } from './declaration.ts';

const semantic = { tier: 'integration' as const,
  file: 'tests/qa/integration/semantic-change.test.ts',
  name: 'MODEL01/MODEL03/MODEL04/MODEL08/MODEL10/MODEL14: semantic change write, exact read, denial, stale and references' };
const relation = { tier: 'integration' as const,
  file: 'tests/qa/integration/relation-change.test.ts',
  name: 'MODEL05/MODEL06: repeated participants keep two identified occurrences and a retired definition keeps exact meaning' };
const semanticRecovery = { tier: 'fault/recovery' as const,
  file: 'tests/qa/fault-recovery/semantic-lost-response.test.ts',
  name: 'MODEL01/MODEL14: a lost semantic graph acknowledgement resolves one receipt and event' };
const relationRecovery = { tier: 'fault/recovery' as const,
  file: 'tests/qa/fault-recovery/semantic-relation-lost-response.test.ts',
  name: 'MODEL05/MODEL06: a lost relation graph acknowledgement retains one occurrence and exact definition' };

export const modelSemanticCases: CaseDeclarations = {
  MODEL01: [semantic, semanticRecovery],
  MODEL03: [semantic],
  MODEL04: [semantic],
  MODEL05: [relation, relationRecovery],
  MODEL06: [relation, relationRecovery],
  MODEL08: [semantic],
  MODEL10: [semantic],
  MODEL14: [semantic, semanticRecovery, { tier: 'model', file: 'model/compiler/generate.test.ts',
    name: 'MODEL14: compiler closes owner shapes and keeps the shared Resource shape open' }],
};
