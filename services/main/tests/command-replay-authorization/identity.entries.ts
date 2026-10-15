import { randomUUID } from 'node:crypto';
import { expect, spyOn } from 'bun:test';
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
import { AliasConflict, type AliasReceipt, type AliasScope, type AliasWrite } from '../../src/modules/address/registry.ts';
import { writeAlias } from '../../src/modules/address/write.ts';
import { createAdmittedRealmSpace, createAdmittedZoneSpace } from '../../src/modules/space/create-admitted.ts';
import { type ReplayEntry, type Scenario, type Member, root, stack, legacyPool, legacyController, principal, request, head, graphSnapshot, loseGrant } from './fixtures.ts';

type AddressPath = 'agent' | 'work' | 'realm-settings' | 'realm-owner' | 'zone-space' | 'zone-address';
type AddressCommand = 'claim' | 'rename' | 'disposition';

async function setupResponse<T>(response: Response, status: number): Promise<T> {
  const body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body) as T;
}

async function prepareMergedWork(creator: Member, source: Awaited<ReturnType<typeof createAdmittedMetadataWork>>) {
  const deps = stack.composition.dependencies;
  const survivor = await createAdmittedMetadataWork(stack.env, deps.account, stack.access, request(creator), {
    actingSubject: creator.actor, title: 'Retained duplicate survivor', language: 'en', idempotencyKey: randomUUID(),
  });
  const first = await stack.member(randomUUID()), second = await stack.member(randomUUID());
  for (const person of [creator, first, second]) {
    await person.grant('work:create:root', 'agent.control');
    await person.grant('editorial:review:urn:rezics:context:global', 'work.review');
    for (const work of [source.work, survivor.work]) {
      await person.grant(`work:edit:${work}`, 'work.edit');
      await person.grant(`work:read:${work}`, 'work.read');
    }
  }
  const evidence = [{ resource: source.work, revision: source.workRevision, locator: 'duplicate-title-and-grain' }];
  const proposal = await setupResponse<{ proposal: string }>(await creator.send('POST', '/v1/editorial/proposals', {
    profile: 'editorial-proposal-create-v1', kind: 'merge', actingSubject: creator.actor,
    target: { resource: source.work, revision: source.workRevision, context: 'urn:rezics:context:global' },
    candidate: { operation: 'merge', source: { resource: source.work, revision: source.workRevision },
      survivor: { resource: survivor.work, revision: survivor.workRevision }, evidence },
    baseHeads: [{ component: source.work, head: source.workRevision }, { component: survivor.work, head: survivor.workRevision }],
    evidence,
  }), 201);
  await setupResponse(await first.send('POST', `/v1/editorial/proposals/${proposal.proposal}/reviews`, {
    profile: 'editorial-proposal-review-v1', revision: 1, outcome: 'approve', message: 'Checked both identities',
    actingSubject: first.actor,
  }), 200);
  const key = randomUUID();
  for (let attempt = 0; attempt < 16; attempt++) {
    const response = await second.send('POST', `/v1/editorial/proposals/${proposal.proposal}/decisions`, {
      profile: 'editorial-proposal-decide-v1', revision: 1, outcome: 'applied', approve: true,
      message: 'Apply the reviewed duplicate merge', actingSubject: second.actor,
    }, key);
    const result = await setupResponse<{ outcome: string }>(response, response.status === 202 ? 202 : 200);
    if (result.outcome === 'applied') return survivor;
    expect(result.outcome).toBe('apply_pending');
  }
  throw new Error('Reviewed duplicate merge did not complete within its bounded owner stages');
}

async function addressScenario(path: AddressPath, command: AddressCommand, subcase: string): Promise<Scenario> {
  const deps = stack.composition.dependencies;
  const member = await stack.member(randomUUID()), creator = await stack.member(randomUUID());
  const operation: AliasWrite['operation'] = command === 'disposition' ? (subcase === 'merge' ? 'merge' : 'release') : command;
  let scope: AliasScope = 'agent', holder = member.actor, authorityScope = 'work:create:root', action = 'agent.control';
  let successor: string | undefined;
  let ownerSnapshot: () => Promise<unknown> = () => graphSnapshot(member.actor, 'urn:rezics:receipt:absent');
  if (path === 'work') {
    await creator.grant('work:create:root', 'work.create');
    const made = await createAdmittedMetadataWork(stack.env, deps.account, stack.access, request(creator), {
      actingSubject: creator.actor, title: 'Address replay holder', language: 'en', idempotencyKey: randomUUID(),
    });
    scope = 'work'; holder = made.work;
    const family = command === 'disposition' ? 'dispose' : command;
    authorityScope = `address:${family}:${holder}`; action = `address.${family}`;
    if (operation === 'merge') successor = (await prepareMergedWork(creator, made)).work;
    ownerSnapshot = () => graphSnapshot(holder, made.receipt);
  } else if (path !== 'agent') {
    await creator.grant('space:create:root', 'space.create');
    const input = { name: 'Address replay Space', actingSubject: creator.actor, idempotencyKey: randomUUID() };
    const realm = path === 'realm-settings' || path === 'realm-owner';
    const made = realm
      ? await createAdmittedRealmSpace(stack.env, deps.account, stack.access, request(creator), input, deps.realmAdmin)
      : await createAdmittedZoneSpace(stack.env, deps.account, stack.access, request(creator), input);
    holder = path === 'zone-address' ? made.zone! : made.space!;
    scope = path === 'zone-address' ? `zone:${made.space!}` : 'space';
    authorityScope = realm ? `governance:realm:${made.realm!}` : `zone:edit:${made.zone!}`;
    action = realm ? (path === 'realm-owner' ? 'realm.owner' : 'realm.settings.manage') : 'zone.edit';
    ownerSnapshot = () => graphSnapshot(made.space!, made.receipt);
  }
  const spare = path === 'agent' ? await stack.member(randomUUID()) : null;
  const grant = () => grantFixtureAuthority(stack.accessPool, { scope: authorityScope, requireDispatch: true,
    representations: [{ principalId: member.principalId, actor: member.actor, action,
      lifetime: path === 'agent' ? 'infinity' : '8 hours' },
    ...(spare ? [{ principalId: spare.principalId, actor: member.actor, action: 'agent.control', lifetime: 'infinity' as const }] : [])],
    grant: { actor: member.actor, action, lifetime: path === 'agent' ? 'infinity' : '8 hours' } });
  const authority = await grant();
  if (path === 'work' && command !== 'claim') await member.grant(`address:claim:${holder}`, 'address.claim');
  if (path === 'work' && command === 'claim') await member.grant(`address:rename:${holder}`, 'address.rename');
  const alias = () => `replay-${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  // Alias cooldown uses the application clock; SQL effects and receipt dates
  // retain their real owner timestamps. Each call restores the clock on refusal.
  const afterCooldown = Date.now() + 31 * 86_400_000;
  const write = async (input: AliasWrite) => {
    const clock = path === 'agent' ? spyOn(Date, 'now').mockReturnValue(afterCooldown) : null;
    try { return await writeAlias(deps, request(member), input); }
    finally { clock?.mockRestore(); }
  };
  const base = { scope, holder, actingSubject: member.actor };
  const initial = command === 'claim' ? null : await write({ ...base, operation: 'claim', alias: alias(),
    expectedRevision: null, idempotencyKey: randomUUID() });
  const input: AliasWrite = { ...base, operation, expectedRevision: initial?.revision ?? null,
    idempotencyKey: randomUUID(), ...(['claim', 'rename'].includes(operation) ? { alias: alias() } : {}),
    ...(successor ? { successor } : {}) };
  let saved: AliasReceipt, currentRevision: string | null = input.expectedRevision;
  return { command: async (fresh, changed) => {
    const result = await write({ ...input, ...(fresh ? { idempotencyKey: randomUUID(),
      expectedRevision: operation === 'claim' ? null : currentRevision } : {}),
    ...(changed ? (input.alias ? { alias: alias() } : { expectedRevision: randomUUID() }) : {}) });
    saved ??= result;
    return result;
  }, advance: async () => {
    const next = await write({ ...base, operation: command === 'disposition' ? 'claim' : 'rename',
      alias: alias(), expectedRevision: command === 'disposition' ? null : saved.revision, idempotencyKey: randomUUID() });
    currentRevision = next.revision;
  }, lose: async loss => {
    if (path === 'agent') await deactivateFixtureController(stack.accessPool, authority.representationIds[0]!);
    else await loseGrant(member, authority.grantId, loss);
  }, restore: async () => { await grant(); },
  snapshot: async () => ({ owner: await ownerSnapshot(),
    aliases: (await stack.accessPool.query(`SELECT to_jsonb(a) AS row FROM access.alias_registry a
      WHERE holder = $1 ORDER BY scope,key`, [holder])).rows,
    history: (await stack.accessPool.query(`SELECT to_jsonb(h) AS row FROM access.alias_history h
      WHERE holder = $1 ORDER BY revision`, [holder])).rows,
    receipts: (await stack.accessPool.query(`SELECT to_jsonb(r) AS row FROM access.alias_receipt r
      WHERE principal_id = $1 ORDER BY idempotency_key`, [member.principalId])).rows,
  }) };
}

const addressEntries: ReplayEntry[] = (['claim', 'rename', 'disposition'] as const).flatMap(command =>
  (['agent', 'work', 'realm-settings', 'realm-owner', 'zone-space', 'zone-address'] as const).map(path => ({
    operation: `POST /v1/addresses/${command === 'claim' ? 'claims' : command === 'rename' ? 'renames' : 'dispositions'}`,
    authorityClass: path === 'agent' ? 'controller' : 'domain-grant',
    scope: path === 'agent' ? 'agent:control:{agent}' : path === 'work' ? `address:${command === 'disposition' ? 'dispose' : command}:{work}`
      : path.startsWith('realm-') ? 'governance:realm:{realm}' : 'zone:edit:{zone}',
    action: path === 'agent' ? 'agent.control' : path === 'work' ? `address.${command === 'disposition' ? 'dispose' : command}`
      : path === 'realm-owner' ? 'realm.owner' : path === 'realm-settings' ? 'realm.settings.manage' : 'zone.edit',
    family: `${path} address ${command}`, owners: ['modules/address/write.ts#writeAlias', 'modules/address/registry.ts#AliasRegistry.write'],
    subcases: command === 'disposition' && path === 'work' ? ['release', 'merge'] : [command === 'disposition' ? 'release' : command],
    losses: path === 'agent' ? ['revoked'] : ['expired', 'revoked'], denied: AdmissionDenied, conflict: AliasConflict,
    registration: 'turned', requestBuilder: subcase => addressScenario(path, command, subcase),
  })));

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
    denied: AdmissionDenied, conflict: AdmissionConflict, registration: 'turned',
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
    } },
  ...addressEntries,
];

export const area = "identity";
export const moduleOwners = ["address", "addresses", "agent", "profiles", "onboarding", "owner"];
export const replayEntries = entries;
export const coveredOperations = [...new Set(replayEntries.map(entry => entry.operation))];
export const uncoveredOperations: string[] = [
  "POST /v1/agents",
  "POST /v1/me/onboarding",
  "POST /v1/owners/relocations",
  "POST /v1/owners/reconciliations"
];
