import type { CaseDeclarations } from './declaration.ts';

const api = 'tests/qa/integration/access-topology-api.test.ts';
const schema = 'tests/qa/integration/access-topology-schema.test.ts';
const integration = 'integration' as const;

export const iamTopologyCases: CaseDeclarations = {
  IAM05: [
    { tier: integration, file: 'tests/qa/integration/access-group-api.test.ts',
      name: 'IAM05/IAM30/IAM36: group changes and independent impact approval preserve ceilings' },
    { tier: integration, file: api,
      name: 'IAM05/IAM30: a protected group member needs an independent approved activation' },
    { tier: integration, file: api,
      name: 'IAM05/IAM30: a populated protected role changes only with approved rebind' },
    { tier: integration, file: schema,
      name: 'IAM05/IAM30: protected sets and privileged automation need the resulting approved change' },
  ],
  IAM08: [
    { tier: integration, file: api,
      name: 'IAM08: last controller is retained and independent recovery replaces it' },
    { tier: integration, file: api,
      name: 'IAM08: independent Account claim replaces a compromised credential and fences old tokens' },
    { tier: integration, file: schema,
      name: 'IAM08: Agent control keeps continuity and recovers only through an independent authority' },
  ],
  IAM12: [
    { tier: integration, file: api,
      name: 'IAM12: invitation remains pending until the recipient Agent admits its representative' },
    { tier: integration, file: schema,
      name: 'IAM12: an invitation to an unadmitted author stays pending until its own representative accepts' },
  ],
  IAM13: [
    { tier: integration, file: api,
      name: 'IAM13/IAM14: dependent grants revoke with their upstream and replay exactly' },
    { tier: integration, file: schema,
      name: 'IAM13/IAM14: institutional grants survive their operator while dependent grants follow upstream' },
  ],
  IAM14: [
    { tier: integration, file: api,
      name: 'IAM13/IAM14: dependent grants revoke with their upstream and replay exactly' },
    { tier: integration, file: schema,
      name: 'IAM13/IAM14: institutional grants survive their operator while dependent grants follow upstream' },
  ],
  IAM27: [
    { tier: integration, file: api,
      name: 'IAM27/IAM28: two complete P-to-A-to-B-to-C proofs consume one real grant revocation' },
    { tier: integration, file: api,
      name: 'IAM27/IAM28/IAM31: admitted path is exact, acyclic and loses revoked edges' },
    { tier: integration, file: schema,
      name: 'IAM27/IAM31: representation edges stay acyclic under concurrent writers and paths stay bounded' },
    { tier: integration, file: schema,
      name: 'IAM27/IAM31: topology and fan-out guards report bounded unavailability' },
  ],
  IAM28: [
    { tier: integration, file: api,
      name: 'IAM27/IAM28: two complete P-to-A-to-B-to-C proofs consume one real grant revocation' },
    { tier: integration, file: api,
      name: 'IAM27/IAM28/IAM31: admitted path is exact, acyclic and loses revoked edges' },
    { tier: integration, file: schema,
      name: 'IAM28: a compound admission holds one complete proof per obligation and rejects pooling' },
  ],
  IAM30: [
    { tier: integration, file: api,
      name: 'IAM05/IAM30: a protected group member needs an independent approved activation' },
    { tier: integration, file: api,
      name: 'IAM05/IAM30: a populated protected role changes only with approved rebind' },
    { tier: integration, file: api,
      name: 'IAM30: privileged automation requires the owner and approver ceilings' },
    { tier: integration, file: schema,
      name: 'IAM05/IAM30: protected sets and privileged automation need the resulting approved change' },
  ],
  IAM31: [
    { tier: integration, file: api,
      name: 'IAM27/IAM28/IAM31: admitted path is exact, acyclic and loses revoked edges' },
    { tier: integration, file: schema,
      name: 'IAM27/IAM31: representation edges stay acyclic under concurrent writers and paths stay bounded' },
    { tier: integration, file: schema,
      name: 'IAM27/IAM31: topology and fan-out guards report bounded unavailability' },
  ],
  IAM32: [
    { tier: integration, file: api,
      name: 'IAM32: an approved policy admits roster change and refuses unapproved widening' },
    { tier: integration, file: schema,
      name: 'IAM32: representative roster changes stay inside the approved policy and widening needs its grantor' },
  ],
};
