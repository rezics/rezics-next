import type { CaseDeclarations } from './declaration.ts';

/** Account OIDC boundary cases (G-044). */
export const iamAccountCases: CaseDeclarations = {
  IAM02: [{
    tier: 'integration',
    file: 'services/account/tests/oidc-authorization.integration.test.ts',
    name: 'IAM02: invalid OIDC requests and swapped two-client exchanges leave pending codes and Account authority unchanged',
  }],
};
