import { expect, test } from 'bun:test';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { createAdmittedRealmSpace } from '../src/modules/space/create-admitted.ts';
import { initialRealmSettings, spaceCreationDigest, spaceCreationReceiptIri } from '../src/modules/space/create.ts';
import { RealmAdminConflict, RealmAdminDenied, RealmAdminInvalid, RealmAdminStale,
  RealmAdminUnavailable, type RealmSettings } from '../src/modules/realm-admin/contract.ts';
import { spaceCreationError } from '../src/routes/spaces.ts';
import type { RegisteredAdmission } from '../src/modules/access/admission.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { realmSelectionDigest, InvalidRealmSelectionInput } from '../src/modules/work/select-realm.ts';
import { placeReply } from '../src/modules/realm-reply/graph.ts';
import { RealmReplyStale, type PlacementPreparation } from '../src/modules/realm-reply/content-store.ts';

const actor = 'https://rezics.com/id/00000000-0000-8000-8000-000000000412';
const realm = 'https://rezics.com/id/00000000-0000-8000-8000-000000000413';
const settings: RealmSettings = { visibility: 'private', reviewRequired: true, reviewMode: 'mandatory',
  whoMaySubmit: 'granted', selfJoin: false, rules: [{ id: 'respect', governanceRule: null,
    title: { original: 'en', labels: { en: 'Respect', ja: '尊重' } },
    body: { original: 'en', labels: { en: 'Respect readers.\nDiscuss books.', ja: '読者を尊重する。' } } }] };
const input = { name: 'Readers', actingSubject: actor, initialSettings: settings };
const policyRevisions = [spaceCreationReceiptIri('00000000-0000-8000-8000-000000000414'),
  'urn:rezics:realm-policy:00000000-0000-8000-8000-000000000415'];

test('Realm selection accepts creation and later policy receipt forms while binding each exact revision', () => {
  const selection = { context: { kind: 'realm-local' as const, id: realm }, work: actor,
    mainVersion: actor, contribution: actor, publicationDecision: actor, actingSubject: actor,
    selectionBasis: 'realm-policy' as const, expectedSelectionHead: null };
  const digests = policyRevisions.map(revision => realmSelectionDigest({ ...selection,
    policy: { revision, mode: 'open' } }));
  expect(digests[0]).toMatch(/^[0-9a-f]{64}$/);
  expect(digests[1]).toMatch(/^[0-9a-f]{64}$/);
  expect(digests[0]).not.toBe(digests[1]);
  for (const revision of [actor, 'urn:rezics:receipt:short', 'urn:rezics:realm-policy:short']) {
    expect(() => realmSelectionDigest({ ...selection, policy: { revision, mode: 'open' } }))
      .toThrow(InvalidRealmSelectionInput);
  }
});

test.each(policyRevisions)('Reply placement and stale recovery use the Realm policy head for %s', async revision => {
  const admission: RegisteredAdmission = { id: '00000000-0000-8000-8000-000000000416',
    principalId: 'principal', actingSubject: actor, action: 'reply.place', scope: `reply:place:${realm}`,
    idempotencyKey: 'placement', requestDigest: 'a'.repeat(64), authorityEpoch: '0',
    expiresAt: new Date(Date.now() + 60_000).toISOString(), state: 'claimed', dispatchEligible: true, replayed: false };
  const preparation: PlacementPreparation = { operationId: admission.id, realm, reply: actor,
    revisionId: admission.id, revisionDigest: 'b'.repeat(64), reviewDecisionId: admission.id,
    reviewGeneration: '1', reviewDigest: 'c'.repeat(64), author: actor,
    ownerDataEpoch: 'content', ownerSequence: '1', rootTarget: actor, rootRevision: actor,
    parentReply: null, parentRevision: null, contextRevision: null, replayed: false,
    directPolicyRevision: revision };
  const graph = new FusekiClient('http://unused.test');
  const updates: string[] = [], queries: string[] = [];
  graph.commandHealth = async () => ({ moduleVersion: '', instanceId: '', publicSearchWriteEpoch: '',
    publicSearchWriteActive: false,
    profiles: Object.fromEntries(Object.entries(profileRegistry).map(([id, profile]) => [id, profile.sha256])) });
  graph.query = async query => { queries.push(query); return { boolean: false, results: { bindings: [] } }; };
  graph.commandWithReceipt = async command => { updates.push(command.update); return { status: 'guard-unmatched' }; };
  await expect(placeReply({ fuseki: graph, objectDirectory: '.temp/unused',
    lineage: { dataEpoch: 'test', routingEpoch: 'test' } }, admission, preparation, null))
    .rejects.toBeInstanceOf(RealmReplyStale);
  const guard = `<${realm}> rv:realmPolicyHead <${revision}>`;
  expect(updates).toHaveLength(1);
  expect(updates[0]).toContain(guard);
  expect(updates[0]).not.toContain('rv:publicProfileHead');
  const recoveryQuery = queries.find(query => query.includes('ASK'))!.replace(/\s+/g, ' ');
  expect(recoveryQuery).toContain(guard);
  expect(recoveryQuery).not.toContain('rv:publicProfileHead');
});

test('Creation binds disclosure, admission, review mode and ordered initial rules to its key', () => {
  const digest = spaceCreationDigest(input);
  for (const change of [{ visibility: 'public' }, { whoMaySubmit: 'closed' }, { selfJoin: true },
    { reviewRequired: false, reviewMode: 'open' }, { rules: [] }] as Partial<RealmSettings>[]) {
    expect(spaceCreationDigest({ ...input, initialSettings: { ...settings, ...change } })).not.toBe(digest);
  }
  expect(spaceCreationDigest({ ...input, initialSettings: { ...settings, rules: [{ ...settings.rules[0]!,
    title: { original: 'en', labels: { ja: '尊重', en: 'Respect' } } }] } })).toBe(digest);
  expect(initialRealmSettings({ name: 'Legacy', actingSubject: actor })).toEqual({ visibility: 'public',
    reviewRequired: true, reviewMode: 'mandatory', whoMaySubmit: 'granted', selfJoin: false, rules: [] });
});

test('Invalid initial settings are refused before an admission, alias or graph write', async () => {
  const graph = new FusekiClient('http://unused.test');
  graph.query = () => { throw new Error('Graph must not be called'); };
  const unreachable = () => { throw new Error('Access must not be called'); };
  for (const invalid of [{ ...settings, reviewRequired: false }, { ...settings, rules: [...settings.rules, ...settings.rules] },
    { ...settings, rules: [{ ...settings.rules[0]!, title: { original: 'en', labels: { ja: '尊重' } } }] }]) {
    expect(() => spaceCreationDigest({ ...input, initialSettings: invalid })).toThrow(RealmAdminInvalid);
    await expect(createAdmittedRealmSpace({ fuseki: graph, objectDirectory: '.temp/unused',
      lineage: { dataEpoch: 'test', routingEpoch: 'test' } }, { verify: unreachable },
    { register: unreachable, claim: unreachable, recordGraphOutcome: unreachable }, new Request('http://main.test'),
    { ...input, initialSettings: invalid, idempotencyKey: 'creation' }, { initializeCreated: unreachable }))
      .rejects.toBeInstanceOf(RealmAdminInvalid);
  }
  expect(() => spaceCreationDigest({ ...input, initialSettings: { ...settings,
    rules: Array.from({ length: 6 }, (_, index) => ({ ...settings.rules[0]!, id: `rule-${index}`,
      body: { original: 'ja', labels: { ja: '尊'.repeat(1000) } } })) } })).toThrow('Rules exceed the governance document budget');
});

test('A sealed graph receipt resumes failed initialization before creation can report success', async () => {
  const digest = spaceCreationDigest(input);
  const admission: RegisteredAdmission = { id: '00000000-0000-8000-8000-000000000414',
    principalId: 'principal', actingSubject: actor, action: 'space.create', scope: 'space:create:root',
    idempotencyKey: 'creation', requestDigest: digest, authorityEpoch: '0',
    expiresAt: new Date(Date.now() + 60_000).toISOString(), state: 'sealed', dispatchEligible: false, replayed: true };
  const graph = new FusekiClient('http://unused.test');
  graph.query = async query => query.includes('SELECT') ? { results: { bindings: [Object.fromEntries(
    Object.entries({ outcome: 'https://rezics.com/vocab/Succeeded', digest, id: admission.id, epoch: '0',
      scope: admission.scope, dataEpoch: 'test', sequence: '1', space: actor, realm,
      spaceRevision: actor, realmRevision: realm, owner: actor }).map(([key, value]) => [key, { type: 'literal', value }]))] } }
    : { boolean: true };
  graph.commandWithReceipt = () => { throw new Error('A replay must not dispatch a graph write'); };
  const effects: string[] = [];
  let fail = true;
  const initializeCreated: Parameters<typeof createAdmittedRealmSpace>[5] = { initializeCreated: async (_principal, intent) => {
    effects.push('initialize');
    expect(intent).toMatchObject({ realm, actingSubject: actor, creationKey: 'creation', creationDigest: digest,
      policyReceipt: admission.id,
      settings: { visibility: 'private', selfJoin: false }, rules: settings.rules });
    if (fail) throw new RealmAdminUnavailable('Injected Access failure');
    return { realm, accessRevision: '1', replayed: true };
  } };
  const run = () => createAdmittedRealmSpace({ fuseki: graph, objectDirectory: '.temp/unused',
    lineage: { dataEpoch: 'test', routingEpoch: 'test' } }, { verify: async () => ({ issuer: 'qa', subject: 'creator' }) },
  { register: async () => admission, claim: () => { throw new Error('No claim on a sealed receipt'); },
    recordGraphOutcome: async (_id, proof) => { expect(proof.receipt).toBe(spaceCreationReceiptIri(admission.id)); effects.push('ack'); } },
  new Request('http://main.test'), { ...input, idempotencyKey: 'creation' }, initializeCreated);
  await expect(run()).rejects.toBeInstanceOf(RealmAdminUnavailable);
  fail = false;
  expect(await run()).toMatchObject({ realm, replayed: true });
  expect(effects).toEqual(['ack', 'initialize', 'ack', 'initialize']);
});

test('Creation reports initialization denials, conflicts, stale state and unavailability as existing problem types', async () => {
  for (const [error, status, code] of [
    [new RealmAdminInvalid('invalid'), 400, 'invalid_realm_management_request'],
    [new RealmAdminDenied('denied'), 403, 'realm_management_denied'],
    [new RealmAdminConflict('conflict'), 409, 'idempotency_conflict'],
    [new RealmAdminStale('stale'), 409, 'stale_realm_management_basis'],
    [new RealmAdminUnavailable('unavailable'), 503, 'realm_management_unavailable'],
  ] as const) {
    const response = spaceCreationError(error);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
  }
});
