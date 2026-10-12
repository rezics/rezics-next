import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { ObjectReadBudgetExceeded, ObjectUnavailable,
  type ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { prepareComponent, RV } from '../src/modules/work/activate.ts';
import { inventoryPersonProfileGraph, personProfileErasureUpdate,
  PersonGraphErasureConflict, PersonGraphErasureUnavailable,
  type PersonProfileInventoryBudget } from '../src/modules/agent/erasure.ts';
import type { EndedPersonProvision, PersonProfileErasureProof } from '../src/modules/access/person-profile-erasure.ts';

const temporaryRoot = resolve(import.meta.dir, '../../../.temp');
mkdirSync(temporaryRoot, { recursive: true });
const directory = mkdtempSync(join(temporaryRoot, 'person-profile-inventory-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const person: EndedPersonProvision = { person: `https://rezics.com/id/${id('1')}`,
  provisionId: id('2'), principalId: id('3'), requestDigest: 'ab'.repeat(32),
  graphDataEpoch: 'fixture-epoch', graphSequence: '1', subjectEpoch: '2' };
const proof: PersonProfileErasureProof = { ...person, erasureId: id('4'), erasureEpoch: '7',
  accountErasureId: id('5'), deletionIntentId: id('6'), deletionEnforcementEpoch: '1' };
const anchor = `https://rezics.com/id/${person.provisionId}-agent-revision`;
const profile = 'https://rezics.com/definition/agent-provision-v1';
const manifest = `urn:rezics:sha256:${prepareComponent(directory, person.person,
  { kind: 'person', displayName: 'Exact identifying name', disclosure: 'public' }, profile)}`;
const uri = (value: string) => ({ type: 'uri', value });
const literal = (value: string) => ({ type: 'literal', value });
const budget = (): PersonProfileInventoryBudget => ({ bytesLeft: 8 * 1024 * 1024,
  graphRevisionsLeft: 64, indexedUnitsLeft: 64, journalTargetsLeft: 256,
  signal: new AbortController().signal });
const revision = () => ({ revision: uri(anchor), model: uri(profile),
  operation: uri(`urn:rezics:operation:agent-provision:${person.provisionId}`),
  manifest: uri(manifest), profile: literal('false'), anchor: literal('true') });
const fields = () => [
  { p: uri('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), o: uri(`${RV}Agent`) },
  { p: uri(`${RV}agentKind`), o: uri(`${RV}PersonAgent`) },
  { p: uri(`${RV}head`), o: uri(anchor) },
  { p: uri('http://www.w3.org/2000/01/rdf-schema#label'), o: literal('Exact identifying name') },
];
const publicGraph = 'urn:rezics:search:public';
const nameUnit = 'urn:rezics:search:name:agent:00000000-0000-4000-8000-000000000001';
const prefixUnit = 'urn:rezics:search:directory:prefix:RXhhY3Q:*:1fixture';
function fixture(overrides: { kind?: string; revisions?: ReturnType<typeof revision>[];
  currentFields?: ReturnType<typeof fields>; units?: { graph: ReturnType<typeof uri>; unit: ReturnType<typeof uri> }[];
  authorUnits?: { unit: ReturnType<typeof uri> }[]; works?: { work: ReturnType<typeof uri> }[] } = {}): Pick<FusekiClient, 'query'> {
  return { query: async (query: string) => {
    if (query.includes('SELECT ?kind')) return { results: { bindings: [{
      kind: uri(`${RV}${overrides.kind ?? 'PersonAgent'}`), head: uri(anchor) }] } };
    if (query.includes('SELECT ?p ?o')) return { results: { bindings: overrides.currentFields ?? fields() } };
    if (query.includes('SELECT DISTINCT ?revision')) return { results: { bindings: overrides.revisions ?? [revision()] } };
    if (query.includes('SELECT ?revision ?component')) return { results: { bindings: [{ revision: uri(anchor), component: uri(person.person) }] } };
    if (query.includes('SELECT DISTINCT ?graph')) return { results: { bindings: overrides.units ?? [{ graph: uri(publicGraph), unit: uri(nameUnit) }] } };
    if (query.includes('SELECT DISTINCT ?work')) return { results: { bindings: overrides.works ?? [{ work: uri(`https://rezics.com/id/${id('8')}`) }] } };
    if (query.includes('SELECT DISTINCT ?unit')) return { results: { bindings: overrides.authorUnits ?? [{ unit: uri(prefixUnit) }] } };
    throw new Error(`Unexpected inventory query: ${query.slice(0, 80)}`);
  } } as Pick<FusekiClient, 'query'>;
}

test('inventory captures both original immutable objects and direct/credited projections in one shared budget', async () => {
  const shared = budget();
  const inventory = await inventoryPersonProfileGraph(fixture(), directory, person, shared);
  expect(inventory.revisions).toEqual([{ revision: anchor, manifest }]);
  expect(inventory.objects).toHaveLength(2);
  expect(inventory.objects).toContain(`sha256:${manifest.slice(-64)}`);
  expect(inventory.units).toEqual([{ graph: publicGraph, unit: nameUnit }]);
  expect(inventory.authorUnits).toEqual([prefixUnit]);
  expect(inventory.creditedWorks).toEqual([`https://rezics.com/id/${id('8')}`]);
  expect(shared.graphRevisionsLeft).toBe(63);
  expect(shared.indexedUnitsLeft).toBe(62);
  expect(shared.journalTargetsLeft).toBe(248);
  expect(shared.bytesLeft).toBeLessThan(8 * 1024 * 1024);
});

function remoteObjects(onRead?: (digest: string, maxBytes: number | undefined,
  signal: AbortSignal | undefined) => void): ImmutableObjects {
  const stored = new Map(readdirSync(directory).map(digest => [digest, readFileSync(join(directory, digest))]));
  return {
    async put() { throw new Error('inventory must not write immutable objects'); },
    async get(digest, maxBytes, signal) {
      onRead?.(digest, maxBytes, signal);
      const bytes = stored.get(digest);
      if (!bytes) throw new ObjectUnavailable('retained immutable object is absent');
      if (maxBytes !== undefined && bytes.byteLength > maxBytes) throw new ObjectReadBudgetExceeded('remote body exceeds shared budget');
      return new Uint8Array(bytes);
    },
  };
}

test('remote Person manifests and payloads form the same exact inventory and consume the shared byte budget', async () => {
  const localBudget = budget();
  const local = await inventoryPersonProfileGraph(fixture(), directory, person, localBudget);
  const remoteBudget = budget();
  const reads: { digest: string; maxBytes: number | undefined; signal: AbortSignal | undefined }[] = [];
  const objects = remoteObjects((digest, maxBytes, signal) => reads.push({ digest, maxBytes, signal }));
  const missingDirectory = join(directory, 'remote-only');
  expect(existsSync(missingDirectory)).toBe(false);
  const remote = await inventoryPersonProfileGraph(fixture(), missingDirectory, person, remoteBudget, objects);
  expect(remote).toEqual(local);
  expect(remote.objects).toHaveLength(2);
  expect(reads.map(read => `sha256:${read.digest}`).sort()).toEqual(remote.objects);
  expect(remoteBudget.bytesLeft).toBe(localBudget.bytesLeft);
  expect(reads).toHaveLength(2);
  expect(reads.every(read => read.signal === remoteBudget.signal)).toBe(true);
  expect(reads[0]!.maxBytes).toBeGreaterThan(0);
  expect(reads[1]!.maxBytes).toBe(reads[0]!.maxBytes! - readFileSync(join(directory, reads[0]!.digest)).byteLength);
  expect(existsSync(missingDirectory)).toBe(false);
});

test('remote corruption never falls back to valid local files and remote reads refuse exhaustion or cancellation', async () => {
  const corrupt: ImmutableObjects = { async put() { throw new Error('unexpected write'); },
    async get() { return Buffer.from('wrong digest bytes'); } };
  await expect(inventoryPersonProfileGraph(fixture(), directory, person, budget(), corrupt))
    .rejects.toBeInstanceOf(PersonGraphErasureUnavailable);

  let beforeObjects = 0;
  let responseBytes = 0;
  const localFixture = fixture();
  await inventoryPersonProfileGraph({ query: async (query, maxBytes) => {
    const result = await localFixture.query(query, maxBytes);
    responseBytes += Buffer.byteLength(JSON.stringify(result));
    if (query.includes('SELECT ?revision ?component')) beforeObjects = responseBytes;
    return result;
  } }, directory, person, budget());
  const objectBytes = readdirSync(directory).reduce((sum, digest) => sum + readFileSync(join(directory, digest)).byteLength, 0);
  const limited = budget();
  limited.bytesLeft = beforeObjects + objectBytes - 1;
  let boundedReads = 0;
  await expect(inventoryPersonProfileGraph(fixture(), join(directory, 'remote-only'), person, limited,
    remoteObjects((_digest, maxBytes, signal) => {
      boundedReads++;
      expect(maxBytes).toBeGreaterThan(0);
      expect(signal).toBe(limited.signal);
    }))).rejects.toBeInstanceOf(PersonGraphErasureUnavailable);
  expect(boundedReads).toBeGreaterThan(0);

  const controller = new AbortController();
  const cancelled = { ...budget(), signal: controller.signal };
  let cancelledReads = 0;
  await expect(inventoryPersonProfileGraph(fixture(), join(directory, 'remote-only'), person, cancelled,
    remoteObjects(() => {
      cancelledReads++;
      controller.abort(new Error('remote inventory cancelled'));
    }))).rejects.toThrow();
  expect(cancelledReads).toBe(1);
});

test('wrong kinds, malformed anchors, another owner and unsupported current fields refuse before mutation', async () => {
  for (const kind of ['OrganizationAgent', 'ServiceAgent']) {
    await expect(inventoryPersonProfileGraph(fixture({ kind }), directory, person, budget()))
      .rejects.toBeInstanceOf(PersonGraphErasureUnavailable);
  }
  for (const invalid of [
    { ...revision(), operation: uri('urn:rezics:operation:agent-provision:another') },
    { ...revision(), revision: uri(`https://rezics.com/id/${id('9')}-agent-revision`) },
    { ...revision(), model: uri('https://rezics.com/definition/work-kind-v3') },
    { ...revision(), otherOwner: uri(`https://rezics.com/id/${id('9')}`) },
    { ...revision(), anchor: literal('false') },
  ]) await expect(inventoryPersonProfileGraph(fixture({ revisions: [invalid] }), directory, person, budget()))
    .rejects.toBeInstanceOf(PersonGraphErasureUnavailable);
  await expect(inventoryPersonProfileGraph(fixture({ currentFields: [...fields(), {
    p: uri(`${RV}unreviewedProfileField`), o: literal('identifying copy') }] }), directory, person, budget()))
    .rejects.toBeInstanceOf(PersonGraphErasureUnavailable);
  await expect(inventoryPersonProfileGraph(fixture({ works: Array.from({ length: 65 },
    (_, index) => ({ work: uri(`https://rezics.com/id/${id(String(index + 10))}`) })) }), directory, person, budget()))
    .rejects.toBeInstanceOf(PersonGraphErasureUnavailable);
});

test('shared budget refuses one lookahead, missing payloads and aborted preparation', async () => {
  for (const key of ['graphRevisionsLeft', 'indexedUnitsLeft', 'journalTargetsLeft', 'bytesLeft'] as const) {
    const shared = budget(); shared[key] = 0;
    await expect(inventoryPersonProfileGraph(fixture(), directory, person, shared))
      .rejects.toBeInstanceOf(PersonGraphErasureUnavailable);
  }
  const shared = budget(); shared.indexedUnitsLeft = 1;
  await expect(inventoryPersonProfileGraph(fixture(), directory, person, shared))
    .rejects.toBeInstanceOf(PersonGraphErasureUnavailable);
  await expect(inventoryPersonProfileGraph(fixture(), join(directory, 'missing'), person, budget()))
    .rejects.toBeInstanceOf(PersonGraphErasureUnavailable);
  const controller = new AbortController(); controller.abort(new Error('inventory cancelled'));
  await expect(inventoryPersonProfileGraph(fixture(), directory, person, { ...budget(), signal: controller.signal }))
    .rejects.toThrow('inventory cancelled');
});

test('mismatched Person identities and inventory heads refuse before command generation', async () => {
  const inventory = await inventoryPersonProfileGraph(fixture(), directory, person, budget());
  expect(() => personProfileErasureUpdate({ dataEpoch: 'fixture-epoch', routingEpoch: '1' },
    { ...proof, person: `https://rezics.com/id/${id('9')}` }, inventory)).toThrow(PersonGraphErasureConflict);
  expect(() => personProfileErasureUpdate({ dataEpoch: 'fixture-epoch', routingEpoch: '1' }, proof,
    { ...inventory, head: `https://rezics.com/id/${id('9')}` })).toThrow(PersonGraphErasureConflict);

});
