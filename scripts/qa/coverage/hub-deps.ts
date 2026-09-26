import type { CaseDeclarations } from './declaration.ts';

const file = 'tests/qa/integration/hub-deps-api.test.ts';

export const hubDepsCases: CaseDeclarations = {
  HUB03: [
    { tier: 'integration', file,
      name: 'HUB03/PKG18: every declared npm and Cargo requirement reaches its own scoped concrete lock artifact' },
    { tier: 'integration', file,
      name: 'HUB03: denied, stale-key and concurrent dependency writes have exact outcomes' },
    { tier: 'integration', file,
      name: 'HUB03/PKG18: interrupted import and lost lock response recover to exact requirements, read and replay' },
  ],
  PKG18: [
    { tier: 'integration', file,
      name: 'HUB03/PKG18: every declared npm and Cargo requirement reaches its own scoped concrete lock artifact' },
    { tier: 'integration', file,
      name: 'HUB03/PKG18: interrupted import and lost lock response recover to exact requirements, read and replay' },
  ],
};
