import type { CaseDeclarations } from './declaration.ts';

export const govReportCases: CaseDeclarations = {
  GOV01: [
    { tier: 'integration', file: 'tests/qa/integration/governance-report.test.ts',
      name: 'GOV01: reports anchor exact name, body, Structure and media use with empty and unavailable states' },
    { tier: 'integration', file: 'tests/qa/integration/rights-notice-review.test.ts',
      name: 'GOV01/GOV24: platform reviewers read exact retained rights notices without disclosing the staff projection to reporters' },
    { tier: 'integration', file: 'tests/qa/integration/rights-notice-targets.test.ts',
      name: 'GOV01/GOV02/GOV24: public notices bind exact Content revisions and retries keep their original anchors' },
    { tier: 'integration', file: 'tests/qa/integration/rights-notice-cover.test.ts',
      name: 'GOV01/GOV02/GOV24: public notices bind served Work cover Uses and keep the original evidence after replacement' },
    { tier: 'integration', file: 'tests/qa/integration/rights-public-restriction.test.ts',
      name: 'GOV01/GOV02/GOV03/GOV24/GOV25: public rights restrictions compose across Work, cover Use, Content and party reads' },
  ],
};
