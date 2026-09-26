import type { CaseDeclarations } from './declaration.ts';

export const liveControlCases: CaseDeclarations = {
  LIVE03: [
    { tier: 'integration', file: 'tests/qa/integration/source-field.test.ts',
      name: 'LIVE03: synopsis source refresh yields to a same-value human control epoch' },
  ],
  LIVE05: [
    { tier: 'integration', file: 'tests/qa/integration/source-field.test.ts',
      name: 'LIVE05: generic field withdrawal serializes one support and preserves independent acceptance' },
    { tier: 'integration', file: 'tests/qa/integration/source-field.test.ts',
      name: 'LIVE04/LIVE05: one withdrawal route preserves native credits and independent title support' },
    { tier: 'integration', file: 'tests/qa/integration/source-support-attach.test.ts',
      name: 'LIVE05: two field keys attach exact retained values and one withdrawal keeps native acceptance' },
    { tier: 'integration', file: 'tests/qa/integration/source-attachment-authority.test.ts',
      name: 'LIVE03/LIVE05: attachment authority locks serialize revocation and recheck expiry after waits' },
    { tier: 'integration', file: 'tests/qa/integration/source-field-cost.test.ts',
      name: 'LIVE05/LIVE06/LIVE08: exact source owner lookups have bounded PostgreSQL work' },
    { tier: 'fault/recovery', file: 'tests/qa/fault-recovery/source-author-credit.test.ts',
      name: 'LIVE04/LIVE05/MODEL06/OPS03: native credit, field proof and withdrawals survive held graph recovery' },
  ],
  LIVE06: [
    { tier: 'integration', file: 'tests/qa/integration/source-identity-live.test.ts',
      name: 'LIVE06: current Open Library redirect capture never transfers a native identity or grant' },
    { tier: 'integration', file: 'tests/qa/integration/source-identity.test.ts',
      name: 'LIVE06: native Work heads and Access grants survive a redirect correction proposal' },
    { tier: 'integration', file: 'tests/qa/integration/source-identity.test.ts',
      name: 'LIVE06: exact Open Library redirect shape is admitted while a wrong destination fails' },
  ],
  LIVE08: [
    { tier: 'integration', file: 'tests/qa/integration/source-score-live.test.ts',
      name: 'LIVE08: current Open Library ratings and reading-log counts remain source-only' },
    { tier: 'integration', file: 'tests/qa/integration/source-score.test.ts',
      name: 'LIVE08: retained provider score and user key stay source statistics without native identity' },
  ],
};
