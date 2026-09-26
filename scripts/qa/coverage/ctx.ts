import type { CaseDeclarations } from './declaration.ts';

const statement = 'tests/qa/integration/context-statement-cases.test.ts';
const schema = 'services/main/tests/context-schema.test.ts';

export const ctxCases: CaseDeclarations = {
  CTX02: [
    { tier: 'integration', file: statement,
      name: 'CTX02: v1 heads migrate exactly before the Statement decision fence retires the writer' },
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
};
