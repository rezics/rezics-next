import { entries as related0 } from './access-admissions.entries.ts';
import { randomUUID } from 'node:crypto';
import { AccessAgentControl } from '../../src/modules/access/agent-control.ts';
import { ControlConflict, ControlDenied } from '../../src/modules/access/topology-control.ts';
import { deactivateFixtureController, ensureFixtureScopeGate, grantFixtureAuthority } from '../../src/modules/access/fixture-authority.ts';
import { hash } from '../../src/modules/work/activate.ts';
import { type ReplayEntry, stack, principal } from './fixtures.ts';

export const entries: ReplayEntry[] = [
  { operation: "POST /v1/agents/control", authorityClass: 'controller',
    scope: "access:representation-topology", action: "agent.control", family: 'Agent control policy (authorized before shared receipted helper)',
    owners: ['modules/access/agent-control.ts#AccessAgentControl.configure'],
    subcases: ['controller policy'], losses: ['revoked'], denied: ControlDenied, conflict: ControlConflict,
    registration: 'turned',
    requestBuilder: async () => {
      const member = await stack.member(randomUUID()), recovery = await stack.member(randomUUID());
      const authority = await grantFixtureAuthority(stack.accessPool, { scope: 'work:create:root', requireDispatch: true,
        representations: [{ principalId: member.principalId, actor: member.actor, action: 'agent.control', lifetime: 'infinity' },
          { principalId: recovery.principalId, actor: member.actor, action: 'agent.control', lifetime: 'infinity' }],
        grant: { actor: member.actor, action: 'agent.control', lifetime: 'infinity' } });
      await ensureFixtureScopeGate(stack.accessPool, 'access:representation-topology', { open: true });
      const owner = new AccessAgentControl(stack.accessPool);
      const input = { subjectId: member.actor, recoverySubject: recovery.actor, recoveryApprovals: 1,
        recoveryDelaySeconds: 0, minControllers: 1, maxControllers: 8 };
      const receipt = { idempotencyKey: randomUUID(), requestDigest: hash(JSON.stringify(input)) };
      return { command: async (fresh, changed) => {
        const intent = changed ? { ...input, maxControllers: 7 } : input;
        return owner.configure(await principal(member), { ...receipt, requestDigest: hash(JSON.stringify(intent)),
          ...(fresh ? { idempotencyKey: randomUUID() } : {}) }, intent);
      },
      lose: async () => { await deactivateFixtureController(stack.accessPool, authority.representationIds[0]!); },
      snapshot: async () => (await stack.accessPool.query(`SELECT to_jsonb(c) AS row
        FROM access.agent_control c WHERE subject_id = $1`, [member.actor])).rows };
    } }
];

export const area = "access";
export const moduleOwners = ["access"];
export const replayEntries = [...entries, ...related0];
export const coveredOperations = replayEntries.map(entry => entry.operation);
export const uncoveredOperations: string[] = [
  "POST /v1/access/membership-changes",
  "POST /v1/me/membership-consents",
  "POST /v1/access/revocations",
  "POST /v1/access/interaction-blocks",
  "PUT /v1/me/interaction-mutes",
  "POST /v1/access/policy-changes",
  "PUT /v1/me/main-agent-preference",
  "PUT /v1/me/session-agent",
  "PUT /v1/me/acting-context-preferences/work.create",
  "POST /v1/realms/{}/invitations/{}/revoke",
  "POST /v1/realms/{}/invitations/{}/response",
  "POST /v1/realms/{}/invitations",
  "POST /v1/realms/{}/join",
  "POST /v1/realms/{}/escalations",
  "POST /v1/realms/{}/role-changes",
  "POST /v1/realms/{}/members",
  "PUT /v1/realms/{}/settings",
  "POST /v1/realms/{}/management",
  "PUT /v1/spaces/{}/settings",
  "POST /v1/recipes/{}/file-imports",
  "POST /v1/recipes/{}/timings",
  "POST /v1/recipes/{}/measures"
];
