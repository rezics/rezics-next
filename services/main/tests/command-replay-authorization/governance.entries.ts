import { entries as related0 } from './governance-reports.entries.ts';
import { randomUUID } from 'node:crypto';
import { GovernanceConflict, GovernanceDenied } from '../../src/modules/governance/store.ts';
import { GovernanceRules, RULE_PUBLISH_ACTION } from '../../src/modules/governance/rules.ts';
import { type ReplayEntry, stack, principal, loseGrant } from './fixtures.ts';

export const entries: ReplayEntry[] = [
  { operation: "POST /v1/governance/rules", authorityClass: 'domain-grant',
    scope: "governance:platform", action: "governance.rule.publish", family: 'governance rule publication', owners: ['modules/governance/rules.ts#GovernanceRules.publish'],
    subcases: ['rule revision'], denied: GovernanceDenied, conflict: GovernanceConflict, registration: 'turned',
    requestBuilder: async () => {
      const member = await stack.member(randomUUID());
      const grant = await member.grant('governance:platform', RULE_PUBLISH_ACTION);
      const owner = new GovernanceRules(stack.accessPool);
      const input = { ref: `urn:rezics:rule:${randomUUID()}`, scopeId: 'governance:platform',
        actingSubject: member.actor, expectedRevision: null, document: { rule: 'Review retained evidence.' },
        idempotencyKey: randomUUID() };
      return { command: async (fresh, changed) => owner.publish(await principal(member), { ...input,
        ...(fresh ? { idempotencyKey: randomUUID() } : {}),
        ...(changed ? { document: { rule: 'Different binding.' } } : {}) }),
      lose: loss => loseGrant(member, grant, loss),
      snapshot: async () => (await stack.accessPool.query(`SELECT to_jsonb(r) AS row
        FROM access.governance_rule_revision r WHERE ref = $1 ORDER BY revision`, [input.ref])).rows };
    } }
];

export const area = "governance";
export const moduleOwners = ["governance", "erasure", "rights", "public-report", "protection"];
export const replayEntries = [...entries, ...related0];
export const coveredOperations = replayEntries.map(entry => entry.operation);
export const uncoveredOperations: string[] = [
  "POST /v1/erasures",
  "POST /v1/work-title-corrections/{}/decisions",
  "POST /v1/work-title-corrections",
  "POST /v1/work-title-protections",
  "POST /v1/corrections/{}/decisions",
  "POST /v1/corrections",
  "POST /v1/editorial-protections",
  "POST /v1/governance/process-steps",
  "POST /v1/moderation/decisions",
  "POST /v1/public-reports/{}/correspondence",
  "POST /v1/public-reports",
  "POST /v1/rights/restrictions",
  "POST /v1/rights/use-assessments",
  "POST /v1/safety-decisions/{}/cancellation",
  "POST /v1/safety-cases/{}/decisions"
];
