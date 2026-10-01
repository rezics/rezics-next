// One Access owner facade for the policy, interaction and revocation routes.
import type { Pool } from 'pg';
import { AccessInteractions } from './interaction-decisions.ts';
import { AccessPolicyChanges } from './policy-changes.ts';
import { AccessPolicyDecisions } from './policy-decisions.ts';
import { AccessRevocations } from './revocation-requests.ts';
import { AccessAuthorityRead } from './authority-read.ts';

export class AccessPolicyOwner {
  readonly authorityRead: AccessAuthorityRead;
  readonly changes: AccessPolicyChanges;
  readonly decisions: AccessPolicyDecisions;
  readonly interactions: AccessInteractions;
  readonly revocations: AccessRevocations;
  constructor(pool: Pool) {
    this.authorityRead = new AccessAuthorityRead(pool);
    this.changes = new AccessPolicyChanges(pool);
    this.decisions = new AccessPolicyDecisions(pool);
    this.interactions = new AccessInteractions(pool);
    this.revocations = new AccessRevocations(pool);
  }
}
