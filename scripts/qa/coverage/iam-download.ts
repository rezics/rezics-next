import type { CaseDeclarations } from './declaration.ts';

export const iamDownloadCases: CaseDeclarations = {
  IAM07: [{ tier: 'integration', file: 'tests/qa/integration/access-download-api.test.ts',
    name: 'IAM07: private media download is admitted, bounded, and drained by strong revocation' }, {
    tier: 'integration', file: 'tests/qa/integration/access-revocation-api.test.ts',
    name: 'IAM07: strong revocation fences new admission and completes only after admitted command and private reads end' }],
};
