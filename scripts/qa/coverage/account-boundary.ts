import type { CaseDeclarations } from './declaration.ts';

/** Account consent/installation refresh fences, signing-key rotation and
 * remote placement (G-072). */
export const accountBoundaryCases: CaseDeclarations = {
  IAM09: [{
    tier: 'integration',
    file: 'services/account/tests/consent-revocation.integration.test.ts',
    name: 'IAM09: withdrawn consent fences old refresh and Main access across clients',
  }, {
    tier: 'integration',
    file: 'tests/qa/integration/account-boundary-installation.test.ts',
    name: 'IAM09: a revoked App installation cannot regain access by refresh, pending code, workload token or reinstallation, and an App update cannot widen its ceiling',
  }, {
    tier: 'integration',
    file: 'tests/qa/integration/account-boundary-installation.test.ts',
    name: 'IAM09: installation checks stay constant-cost as revoked installation history grows',
  }, {
    tier: 'integration',
    file: 'tests/qa/integration/account-boundary-installation.test.ts',
    name: 'IAM09: a refreshed token re-evaluates the selected acting-Agent context and cannot widen its consent ceiling at Main',
  }],
  OPS07: [{
    tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/account-key-rotation.test.ts',
    name: 'OPS07: signing keys rotate and retire while sessions and jobs run; retired keys, audience and validity stay enforced',
  }],
  OPS08: [{
    tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/account-key-remote-placement.test.ts',
    name: 'OPS08: remote Account placement isolates network partition, Account database loss and refused Main credentials, with no private database shortcut',
  }],
};
