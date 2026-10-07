import type { CaseDeclarations } from './declaration.ts';

const statement = 'tests/qa/integration/context-statement-cases.test.ts';
const advanced = 'tests/qa/integration/context-advanced-cases.test.ts';
const rules = 'tests/qa/integration/context-rule-cases.test.ts';
const schema = 'services/main/tests/context-schema.test.ts';

export const ctxCases: CaseDeclarations = {
  CTX02: [
    { tier: 'integration', file: statement,
      name: 'CTX02/CTX09: catalogue imports use exact definitions, replay and CAS; populated conversion retains provenance and rebuilds seek' },
    { tier: 'integration', file: statement,
      name: 'CTX02/CTX03: exact Statement decisions inherit Global, suppress on local reject and fail closed' },
    { tier: 'unit', file: schema,
      name: 'CTX02: schema foundation local rejection suppresses, absence may inherit, unavailable never falls back' },
  ],
  CTX03: [
    { tier: 'integration', file: statement,
      name: 'CTX03: hidden Context basis and explicit unresolved selection never fall back' },
    { tier: 'integration', file: statement,
      name: 'CTX02/CTX03: exact Statement decisions inherit Global, suppress on local reject and fail closed' },
    { tier: 'unit', file: schema,
      name: 'CTX03: schema foundation unresolved and disabled entries are explicit, never absent definitions' },
    { tier: 'integration', file: 'services/main/tests/context-schema.integration.test.ts',
      name: 'CTX03: schema foundation Access private Context selections install empty, upgrade head and guard CAS' },
  ],
  CTX04: [
    { tier: 'integration', file: advanced,
      name: 'CTX04: Global, Realm and personal exact interpretations remain independent of a narrower named target' },
  ],
  CTX05: [
    { tier: 'integration', file: advanced,
      name: 'CTX05: exact relation, value and definition qualify meaning while support and decisions stay separate' },
  ],
  CTX06: [
    { tier: 'integration', file: advanced,
      name: 'CTX06: exact selection precedence and bounded pinned inheritance reject arbitrary mixing' },
    { tier: 'integration', file: rules,
      name: 'CTX06: selected Realm rule conflict rejects before derivation and exact Context closure retains provenance' },
  ],
  CTX07: [
    { tier: 'integration', file: advanced,
      name: 'CTX07: independent Context labels choose scoped SKOS preferred names by language' },
  ],
  CTX09: [
    { tier: 'integration', file: advanced,
      name: 'CTX09: exact DefinitionRef retirement keeps older Statements readable and rejects new use' },
    { tier: 'integration', file: advanced,
      name: 'CTX09: retirement preserves exact Statement meaning and receipts, blocks new adoption, and restores by CAS' },
    { tier: 'integration', file: statement,
      name: 'CTX02/CTX09: catalogue imports use exact definitions, replay and CAS; populated conversion retains provenance and rebuilds seek' },
  ],
  CTX10: [
    { tier: 'integration', file: advanced,
      name: 'CTX08/CTX10: concurrent reparent has one winner; pinned consumers survive bounded head changes' },
    { tier: 'integration', file: rules,
      name: 'CTX10: one rule revision switches a many-target dependent generation with bounded pages' },
  ],
};
