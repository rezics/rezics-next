import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { schemaFiles } from '../../../../scripts/qa/schema-files.ts';
import { deactivateFixtureController, expireFixtureAuthority, grantFixtureAuthority } from '../../src/modules/access/fixture-authority.ts';
import { AgentProfileConflict, AgentProfileDenied, AgentPublicProfiles } from '../../src/modules/agent/profile.ts';
import { AdmissionConflict, AdmissionDenied } from '../../src/modules/access/admission.ts';
import { ControlDenied } from '../../src/modules/access/topology-control.ts';
import { AgentListingConflict } from '../../src/modules/profiles/listing.ts';
import { LibraryVisibilityConflict } from '../../src/modules/profiles/visibility.ts';
import { createNativeCredit } from '../../src/modules/profiles/credits.ts';
import { createAdmittedMetadataWork } from '../../src/modules/work/create-admitted.ts';
import { setAdmittedWorkScalar } from '../../src/modules/work/edit-admitted.ts';
import { workEditReceiptIri } from '../../src/modules/work/edit.ts';
import { type ReplayEntry, root, stack, legacyPool, legacyController, principal, request, head, graphSnapshot, loseGrant } from './fixtures.ts';

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
    } },
  { operation: 'PUT /v1/agents/{}/library-visibility', authorityClass: 'controller',
    scope: 'Agent', action: 'agent.control', family: 'Agent library visibility changes',
    owners: ['modules/profiles/visibility.ts#AgentLibraryVisibilityStore.write'],
    subcases: ['public', 'private'], losses: ['revoked'], denied: ControlDenied,
    conflict: LibraryVisibilityConflict, registration: 'turned',
    requestBuilder: async subcase => {
      const member = await stack.member(randomUUID()), spare = await stack.member(randomUUID());
      const authority = await grantFixtureAuthority(stack.accessPool, { scope: 'work:create:root', requireDispatch: true,
        representations: [{ principalId: member.principalId, actor: member.actor, action: 'agent.control', lifetime: 'infinity' },
          { principalId: spare.principalId, actor: member.actor, action: 'agent.control', lifetime: 'infinity' }],
        grant: { actor: member.actor, action: 'agent.control', lifetime: 'infinity' } });
      const owner = stack.composition.dependencies.profiles!.visibility;
      const visibility = subcase === 'public' ? 'public' : 'private';
      const other = visibility === 'public' ? 'private' : 'public';
      const key = randomUUID();
      let version = 0;
      return { command: async (fresh, changed) => owner.write(await principal(member), member.actor,
        changed ? other : visibility, fresh ? version : 0, fresh ? randomUUID() : key),
      advance: async () => { version = (await owner.write(await principal(member), member.actor, other, 1, randomUUID())).version; },
      // New controller episodes are open-ended; their lawful loss is revocation.
      lose: async () => { await deactivateFixtureController(stack.accessPool, authority.representationIds[0]!); },
      restore: async () => { await member.grant('work:create:root', 'agent.control'); },
      snapshot: async () => ({
        state: (await stack.accessPool.query(`SELECT to_jsonb(v) AS row FROM access.agent_library_visibility v
          WHERE agent_id = $1`, [member.actor])).rows,
        receipts: (await stack.accessPool.query(`SELECT to_jsonb(r) AS row FROM access.agent_library_visibility_receipt r
          WHERE principal_id = $1 ORDER BY idempotency_key`, [member.principalId])).rows,
      }) };
    } },
  { operation: 'PUT /v1/agents/{}/listing', authorityClass: 'controller',
    scope: 'Agent', action: 'agent.control', family: 'Agent discovery listing changes',
    owners: ['modules/profiles/listing.ts#AgentListingStore.write'],
    subcases: ['listed', 'unlisted'], losses: ['revoked'], denied: ControlDenied,
    conflict: AgentListingConflict, registration: 'turned',
    requestBuilder: async subcase => {
      const member = await stack.member(randomUUID()), spare = await stack.member(randomUUID());
      const authority = await grantFixtureAuthority(stack.accessPool, { scope: 'work:create:root', requireDispatch: true,
        representations: [{ principalId: member.principalId, actor: member.actor, action: 'agent.control', lifetime: 'infinity' },
          { principalId: spare.principalId, actor: member.actor, action: 'agent.control', lifetime: 'infinity' }],
        grant: { actor: member.actor, action: 'agent.control', lifetime: 'infinity' } });
      const owner = stack.composition.dependencies.profiles!.listing;
      const listing = subcase === 'listed' ? 'listed' : 'unlisted';
      const other = listing === 'listed' ? 'unlisted' : 'listed';
      const key = randomUUID();
      let version = 0;
      return { command: async (fresh, changed) => owner.write(await principal(member), member.actor,
        changed ? other : listing, fresh ? version : 0, fresh ? randomUUID() : key),
      advance: async () => { version = (await owner.write(await principal(member), member.actor, other, 1, randomUUID())).version; },
      lose: async () => { await deactivateFixtureController(stack.accessPool, authority.representationIds[0]!); },
      restore: async () => { await member.grant('work:create:root', 'agent.control'); },
      snapshot: async () => ({
        state: (await stack.accessPool.query(`SELECT to_jsonb(l) AS row FROM access.agent_listing l
          WHERE agent_id = $1`, [member.actor])).rows,
        receipts: (await stack.accessPool.query(`SELECT to_jsonb(r) AS row FROM access.agent_listing_receipt r
          WHERE principal_id = $1 ORDER BY idempotency_key`, [member.principalId])).rows,
      }) };
    } },
  { operation: 'POST /v1/works/{}/agent-credits', authorityClass: 'domain-grant',
    scope: 'work:edit:{work}', action: 'work.edit', family: 'Native Agent credit creation',
    owners: ['modules/profiles/credits.ts#createNativeCredit'], subcases: ['represented-agent'],
    denied: AdmissionDenied, conflict: AdmissionConflict, registration: 'registered-failing',
    requestBuilder: async () => {
      const member = await stack.member(randomUUID()), credited = await stack.member(randomUUID());
      await member.grant('work:create:root', 'work.create');
      const deps = stack.composition.dependencies;
      const work = await createAdmittedMetadataWork(stack.env, deps.account, stack.access, request(member), {
        actingSubject: member.actor, title: 'Credit replay target', language: 'en', idempotencyKey: randomUUID(),
      });
      const grant = await member.grant(`work:edit:${work.work}`, 'work.edit');
      const key = randomUUID();
      const input = { work: work.work, credit: `https://rezics.com/id/${randomUUID()}`, agent: credited.actor,
        role: 'author' as const, expectedWorkHead: work.workRevision, actingSubject: member.actor };
      let currentHead = work.workRevision;
      let saved: Awaited<ReturnType<typeof createNativeCredit>>;
      return { command: async (fresh, changed) => {
        const result = await createNativeCredit(deps, request(member), { ...input,
          ...(fresh ? { credit: `https://rezics.com/id/${randomUUID()}`, expectedWorkHead: currentHead } : {}),
          ...(changed ? { role: 'translator' as const } : {}),
        }, fresh ? randomUUID() : key);
        saved ??= result;
        return result;
      }, advance: async () => {
        currentHead = (await setAdmittedWorkScalar(stack.env, deps.account, stack.access, request(member), {
          work: work.work, expectedHead: currentHead, actingSubject: member.actor, idempotencyKey: randomUUID(),
          scalarValue: { kind: 'unknown' },
        })).revision;
      }, lose: loss => loseGrant(member, grant, loss),
      restore: async () => { await member.grant(`work:edit:${work.work}`, 'work.edit'); },
      snapshot: async () => {
        const admission = (await stack.accessPool.query<{ id: string }>(`SELECT id FROM access.admission
          WHERE principal_id = $1 AND action = 'work.edit' AND idempotency_key = $2`, [member.principalId, key])).rows[0]!;
        return { credit: await graphSnapshot(saved.credit, workEditReceiptIri(admission.id)),
          work: await graphSnapshot(work.work, work.receipt),
          admissions: (await stack.accessPool.query(`SELECT to_jsonb(a) AS row FROM access.admission a
            WHERE principal_id = $1 ORDER BY id`, [member.principalId])).rows };
      } };
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
  "POST /v1/owners/reconciliations"
];
