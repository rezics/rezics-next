import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { schemaFiles } from '../../../../scripts/qa/schema-files.ts';
import { deactivateFixtureController, expireFixtureAuthority, grantFixtureAuthority } from '../../src/modules/access/fixture-authority.ts';
import { AgentProfileConflict, AgentProfileDenied, AgentPublicProfiles } from '../../src/modules/agent/profile.ts';
import { type ReplayEntry, root, stack, legacyPool, legacyController, principal, head, graphSnapshot } from './fixtures.ts';

export const entries: ReplayEntry[] = [
  { operation: "PUT /v1/agents/{}/profile", authorityClass: 'controller',
    scope: "Agent", action: "agent.control", family: 'Agent profile changes', owners: ['modules/agent/profile.ts#AgentPublicProfiles.change'],
    subcases: ['public profile v1'], denied: AgentProfileDenied, conflict: AgentProfileConflict, registration: 'turned',
    requestBuilder: async (_subcase, loss) => {
      const legacy = loss === 'expired';
      const member = legacy ? legacyController : await stack.member(randomUUID());
      const pool = legacy ? legacyPool : stack.accessPool;
      if (!legacy) {
        const spare = await stack.member('spare-controller');
        await grantFixtureAuthority(pool, { scope: 'work:create:root', requireDispatch: true,
          representations: [{ principalId: member.principalId, actor: member.actor, action: 'agent.control', lifetime: 'infinity' },
            { principalId: spare.principalId, actor: member.actor, action: 'agent.control', lifetime: 'infinity' }],
          grant: { actor: member.actor, action: 'agent.control', lifetime: 'infinity' } });
      }
      const control = (await pool.query<{ id: string }>(`SELECT id FROM access.representation
        WHERE principal_id = $1 AND subject_id = $2 AND action = 'agent.control'`,
      [member.principalId, member.actor])).rows[0]!.id;
      const input = { agent: member.actor, expectedHead: await head(member.actor), displayName: 'Saved name',
        avatarSelection: null, bio: null, idempotencyKey: randomUUID() };
      const owner = legacy ? new AgentPublicProfiles(pool, stack.env, stack.media.store)
        : stack.composition.dependencies.agentProfiles!;
      let saved: Awaited<ReturnType<typeof owner.change>>;
      return { command: async (fresh, changed) => {
        const result = await owner.change(await principal(member), { ...input,
          ...(fresh ? { idempotencyKey: randomUUID(), expectedHead: saved.revision } : {}),
          ...(changed ? { displayName: 'Different binding' } : {}) });
        saved ??= result;
        return result;
      }, advance: async () => { await owner.change(await principal(member), { ...input,
        expectedHead: saved.revision, displayName: 'Advanced name', idempotencyKey: randomUUID() }); },
      lose: async () => {
        if (legacy) {
          await expireFixtureAuthority(pool, member.actor);
          for (const file of schemaFiles(root, 'access').filter(file => Number(file.split('_')[0]) >= 873)) {
            await pool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
          }
        } else await deactivateFixtureController(pool, control);
      }, restore: async () => {
        await grantFixtureAuthority(pool, { scope: 'work:create:root', requireDispatch: true,
          representations: [{ principalId: member.principalId, actor: member.actor, action: 'agent.control', lifetime: 'infinity' }],
          grant: { actor: member.actor, action: 'agent.control', lifetime: 'infinity' } });
      }, snapshot: () => graphSnapshot(member.actor, saved.receipt) };
    } }
];

export const area = "identity";
export const moduleOwners = ["address", "addresses", "agent", "profiles", "onboarding", "owner"];
export const replayEntries = entries;
export const coveredOperations = replayEntries.map(entry => entry.operation);
export const uncoveredOperations: string[] = [
  "POST /v1/addresses/dispositions",
  "POST /v1/addresses/renames",
  "POST /v1/addresses/claims",
  "POST /v1/agents",
  "POST /v1/me/onboarding",
  "POST /v1/owners/relocations",
  "POST /v1/owners/reconciliations",
  "POST /v1/works/{}/agent-credits",
  "PUT /v1/agents/{}/library-visibility",
  "PUT /v1/agents/{}/listing"
];
