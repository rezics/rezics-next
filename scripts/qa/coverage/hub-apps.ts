import type { CaseDeclarations } from './declaration.ts';

const file = 'tests/qa/integration/connected-app-api.test.ts';

export const hubAppsCases: CaseDeclarations = {
  HUB05: [{ tier: 'integration', file,
    name: 'HUB05: tool schema and capability drift invalidate the current Account consent ceiling' }],
  HUB06: [
    { tier: 'integration', file,
      name: 'HUB06: paginated observations, Account scopes, delegated audience and tool/protocol errors stay distinct' },
    { tier: 'integration', file,
      name: 'HUB06: cancellation and lost upstream replies are uncertain, replay safely and never redispatch' },
  ],
};
