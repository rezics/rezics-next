import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import { ObjectIntegrityError, ObjectNotFound, type ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { importRecipe } from '../src/modules/recipe/importer.ts';
import { checkedComponentState } from '../src/modules/semantic/change.ts';
import { PROFILES } from '../src/modules/semantic/schema.ts';
import { compositionReceiptIri, orderTree, recordTree, type CompositionTerminal } from '../src/modules/structure/change.ts';
import { STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT, STRUCTURE_PROFILE,
  type OccurrenceRecord, type OrderEntry, type StructureManifest } from '../src/modules/structure/format.ts';
import { COMPOSITION_PROFILE, derivedId, orderTreeKey, type CompositionHeader } from '../src/modules/structure/graph.ts';
import { readAcknowledgedStructureOccurrence, StructureNativeBasisProblem,
  type AcknowledgedStructureOccurrence } from '../src/modules/structure/native-basis.ts';
import { structureProfileFor } from '../src/modules/structure/profiles.ts';
import { newCost } from '../src/modules/structure/tree.ts';
import { prepareWorkComponent, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { WorkReadMoved, WorkReadSession } from '../src/modules/work/read-session.ts';

type Row = NonNullable<SparqlResult['results']>['bindings'][number];
const row = (values: Record<string, string>): Row => Object.fromEntries(Object.entries(values)
  .map(([key, value]) => [key, { type: 'literal', value }]));
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const principal = { issuer: 'https://account.test', subject: 'structure-reader' };

interface Revision {
  header: CompositionHeader; operation: string; model: string; dataEpoch: string; sequence: string;
}

/** Real immutable trees/manifest/receipt codecs; only storage and Access transports
 * are controlled. This fixture establishes no native-command or public API proof. */
async function fixture(profile = 'recipe-composition') {
  const owner = derivedId('ack-owner'), component = derivedId('ack-main'), structure = derivedId('ack-structure');
  const group = derivedId('ack-group'), first = derivedId('ack-first'), second = derivedId('ack-second');
  const episode = derivedId('ack-episode');
  const bytes = new Map<string, Uint8Array>(), receipts = new Map<string, CompositionTerminal>();
  const operations = new Map<string, string>(), revisions = new Map<string, Revision>(), queries: string[] = [];
  let header: CompositionHeader;
  let writes = 0, active = true, readable = true, disclosed = true, terminalAvailable = true, sequence = 0;
  let ownerReads = 0, withdrawOwnerOnRead = Infinity;
  let ownerRead: ((count: number) => void | Promise<void>) | undefined;
  let objectRead: (() => void) | undefined;
  let targetTypes = ['https://schema.org/TVEpisode'], targetManifest = '', targetChecks = 0;
  let targetHead: string | undefined, targetVersion = 0, targetReadable = true;
  let targetCheck: ((count: number) => void) | undefined, targetUnavailable = false;
  const objects: ImmutableObjects = {
    async put(body) { writes++; const digest = sha256(body); bytes.set(digest, new Uint8Array(body)); return digest; },
    async get(digest) {
      objectRead?.();
      const body = bytes.get(digest);
      if (!body) throw new ObjectNotFound('fixture object is absent');
      if (sha256(body) !== digest) throw new ObjectIntegrityError('fixture object digest differs');
      return new Uint8Array(body);
    },
  };
  const query = async (body: string): Promise<SparqlResult> => {
    queries.push(body);
    let rows: Row[];
    if (body.includes('SELECT ?target WHERE')) {
      targetChecks++;
      targetCheck?.(targetChecks);
      if (targetUnavailable) throw new Error('Native target owner unavailable');
      rows = targetTypes.includes('https://schema.org/TVEpisode')
        && !!targetHead && !targetTypes.includes('https://schema.org/CreativeWork') ? [] : [row({ target: episode })];
    } else if (body.includes('SELECT DISTINCT ?target ?head')) {
      const values = body.match(/VALUES \?target \{([^}]*)\}/)?.[1] ?? '';
      rows = [...new Set([...values.matchAll(/<([^>]+)>/g)].map(match => match[1]!))].map(target => ({
        target: { type: 'uri', value: target },
        ...(target === episode && targetHead ? { head: { type: 'uri', value: targetHead } } : {}),
      }));
    } else if (body.includes('SELECT ?epoch ?sequence ?hold ?r ?type')) {
      rows = [row({ epoch: 'structure-epoch', sequence: String(sequence), r: episode,
        type: 'resource', public: 'false', erased: 'false' })];
    } else if (body.includes('SELECT ?resource ?manifest')) {
      rows = [row({ resource: episode, manifest: targetManifest })];
    } else if (body.includes('SELECT ?main ?public ?structuredDecision')) {
      rows = body.includes(`<${owner}>`) ? [row({ main: component, public: 'false' })] : [];
    } else if (body.includes('SELECT ?work ?head ?owningWork ?owningHead')) {
      rows = body.includes(`<${episode}>`) ? [row({ work: episode, ...(targetHead ? { head: targetHead } : {}) })]
        : [row({ work: owner, head: derivedId('ack-work-head'), owningWork: owner,
          owningHead: derivedId('ack-work-head') })];
    } else if (body.includes('SELECT ?component ?profile ?head ?generation ?count ?manifest')) {
      rows = body.includes(`<${structure}>`) ? [row({ component: header.component,
        profile: structureProfileFor(header.profile).graphProfile, head: header.head,
        generation: header.generation, count: String(header.placementCount), manifest: header.manifest })] : [];
    } else if (body.includes('SELECT ?owner WHERE')) {
      rows = [row({ owner: header.owner })];
    } else if (body.includes('SELECT ?admission ?operation WHERE')) {
      const receipt = [...receipts.values()].find(item => body.includes(`<${item.receipt}>`));
      rows = receipt ? [row({ admission: receipt.admissionId,
        ...(operations.has(receipt.receipt) ? { operation: operations.get(receipt.receipt)! } : {}) })] : [];
    } else if (body.includes('SELECT ?outcome ?reason ?kind ?action')) {
      const receipt = [...receipts.values()].find(item => body.includes(`<${item.receipt}>`));
      rows = receipt && terminalAvailable ? [row({ outcome: `${RV}${receipt.outcome === 'succeeded' ? 'Succeeded' : 'Cancelled'}`,
        digest: receipt.requestDigest, admission: receipt.admissionId, epoch: receipt.authorityEpoch,
        scope: receipt.scope, dataEpoch: receipt.dataEpoch, sequence: receipt.sequence,
        ...(receipt.structure ? { structure: receipt.structure } : {}),
        ...(receipt.revision ? { revision: receipt.revision } : {}),
        ...(receipt.owner ? { owner: receipt.owner } : {}),
        ...(receipt.component ? { component: receipt.component } : {}) })] : [];
    } else if (body.includes('SELECT ?model ?epoch ?sequence')) {
      const revision = [...revisions.values()].find(item => body.includes(`<${item.header.head}>`));
      rows = revision && [revision.header.structure, revision.header.manifest, revision.header.generation,
        revision.operation].every(value => body.includes(`<${value}>`))
        ? [row({ model: revision.model, epoch: revision.dataEpoch, sequence: revision.sequence })] : [];
    } else if (body.includes('SELECT ?manifest ?predecessor ?count ?epoch ?sequence')) {
      const revision = [...revisions.values()].find(item => body.includes(`<${item.header.head}>`));
      rows = revision ? [row({ manifest: revision.header.manifest, count: String(revision.header.placementCount),
        epoch: revision.dataEpoch, sequence: revision.sequence })] : [];
    } else throw new Error(`Unexpected owner query: ${body}`);
    return { results: { bindings: rows } };
  };
  const environment = { fuseki: { query, update: async () => { throw new Error('A read cannot mutate native state'); } },
    lineage: { dataEpoch: 'structure-epoch', routingEpoch: '1' }, structureObjects: objects,
    workObjects: objects } as unknown as WorkActivationEnvironment;
  configureDisclosure(environment, { read: async targets => targets.map(target =>
    target.component === 'structure' && !disclosed ? 'hidden' : 'visible') });
  const dependencies = { environment, access: {
    activePrincipalId: async () => active ? 'principal-1' : null,
    assertRecoveryOpen: async () => {},
    canReadWork: async () => { ownerReads++; await ownerRead?.(ownerReads); return readable && ownerReads < withdrawOwnerOnRead; },
    canReadSemanticResource: async (_principal: unknown, _actor: string, resource: string) => resource === episode && targetReadable,
  } } as unknown as MainWorkDependencies;
  const session = () => {
    const result = new WorkReadSession(dependencies, new Request('https://main.test/private-owner-read'),
      { actingSubject: derivedId('ack-actor') }, { dataEpoch: 'structure-epoch', sequence: String(sequence) });
    result.principal = principal;
    return result;
  };
  const install = async (records: OccurrenceRecord[], ordered?: OrderEntry[]): Promise<AcknowledgedStructureOccurrence> => {
    sequence++;
    const revision = derivedId(`ack-revision-${sequence}`), operation = derivedId(`ack-operation-${sequence}`);
    const cost = newCost(), recordsTree = recordTree(objects), orderingTree = orderTree(objects);
    const root = await recordsTree.apply(await recordsTree.empty(cost),
      new Map(records.map(record => [record.occurrence, record])), cost);
    const entries = ordered ?? records.filter(record => record.state === 'active').map(record => ({
      occurrence: record.occurrence, parent: record.parent,
      segmentKey: record.segmentKey!, orderKey: record.orderKey!,
    }));
    const order = await orderingTree.apply(await orderingTree.empty(cost),
      new Map(entries.map(entry => [orderTreeKey(entry), entry])), cost);
    const manifest: StructureManifest = { format: STRUCTURE_MANIFEST_FORMAT, structure, structureOf: component,
      profile, generation: derivedId('ack-generation'), pageFormat: STRUCTURE_PAGE_FORMAT,
      records: root, order, placementCount: entries.length, measures: [],
      ...(profile === 'book-composition' ? { topGroups: order } : {}),
      model: STRUCTURE_PROFILE, shape: STRUCTURE_PROFILE };
    const digest = await objects.put(new TextEncoder().encode(JSON.stringify(manifest)));
    header = { structure, profile, owner, component, mainVersion: component, work: owner, head: revision,
      generation: manifest.generation, placementCount: entries.length, manifest: `urn:rezics:sha256:${digest}` };
    const admission = derivedId(`ack-admission-${sequence}`).slice('https://rezics.com/id/'.length);
    const receipt = compositionReceiptIri(admission, structureProfileFor(profile).editAction);
    receipts.set(receipt, { outcome: 'succeeded', receipt, admissionId: admission, requestDigest: sha256(`command-${sequence}`),
      authorityEpoch: '7', scope: `work:edit:${owner}`, dataEpoch: 'structure-epoch', sequence: String(sequence),
      structure, revision });
    operations.set(receipt, operation);
    revisions.set(revision, { header: structuredClone(header), operation, model: COMPOSITION_PROFILE,
      dataEpoch: 'structure-epoch', sequence: String(sequence) });
    return { kind: 'structure-occurrence', owner: 'structure', target: owner, component, structure,
      profile, revision, receipt, occurrence: first };
  };
  const introducedBy = derivedId('ack-original-revision');
  const setTargetTypes = async (types: string[]) => {
    targetTypes = [...types];
    const state = checkedComponentState({ component: 'resource', types, lifecycle: 'active',
      properties: [{ predicate: 'https://schema.org/name',
        value: { kind: 'language-string', lexical: 'Retained episode', language: 'en' } }] });
    const digest = await prepareWorkComponent(objects, episode, state, PROFILES.resource);
    targetManifest = `urn:rezics:sha256:${digest}`;
    targetHead = derivedId(`ack-target-revision-${++targetVersion}`);
  };
  if (profile === 'episode-list-v1') await setTargetTypes(targetTypes);
  const records: OccurrenceRecord[] = profile === 'recipe-composition' ? [
    { occurrence: group, state: 'active', parent: structure, segmentKey: 'a', orderKey: 'a', role: 'group',
      labels: [{ value: 'Dough', language: 'en' }], sourceKey: '/recipeIngredient/group', introducedBy },
    ...[first, second].map((occurrence, ordinal): OccurrenceRecord => ({ occurrence, state: 'active', parent: group,
      segmentKey: 'a', orderKey: ordinal ? 'b' : 'a', role: 'ingredient', labels: [],
      sourceKey: `/recipeIngredient/${ordinal}`, introducedBy,
      qualifier: importRecipe({ recipeIngredient: ['1/3 cup flour'] }, 'exact-source').ingredients[0]!.qualifier })),
  ] : profile === 'episode-list-v1' ? [
    { occurrence: group, state: 'active', parent: structure, segmentKey: 'a', orderKey: 'a', role: 'group',
      labels: [], introducedBy },
    ...[first, second].map((occurrence, ordinal): OccurrenceRecord => ({ occurrence, state: 'active', parent: group,
      segmentKey: 'a', orderKey: ordinal ? 'b' : 'a', role: 'episode', target: episode, labels: [], introducedBy,
      qualifier: { type: 'fields', id: 'episode-order-v1', values: {
        position: { numerator: 1, denominator: ordinal ? 1 : 2 }, label: ordinal ? '1' : '0.5',
      } } })),
  ] : [first, second].map((occurrence, ordinal) => ({ occurrence, state: 'active', parent: structure,
    segmentKey: 'a', orderKey: ordinal ? 'b' : 'a', role: 'group', labels: [], introducedBy,
    qualifier: { type: 'book-group', division: 'volume' } }));
  const basis = await install(records);
  return { basis, records, first, second, group, bytes, receipts, revisions, operations, queries, install, session,
    header: () => header, writes: () => writes, episode, setTargetTypes,
    targetChecks: () => targetChecks, onTargetCheck: (fn: (count: number) => void) => { targetCheck = fn; },
    targetTypes: (types: string[]) => { targetTypes = [...types]; },
    targetHead: (head: string | undefined) => { targetHead = head; },
    targetReadable: (value: boolean) => { targetReadable = value; },
    targetUnavailable: (value: boolean) => { targetUnavailable = value; },
    active: (value: boolean) => { active = value; }, readable: (value: boolean) => { readable = value; },
    disclosed: (value: boolean) => { disclosed = value; },
    terminalAvailable: (value: boolean) => { terminalAvailable = value; },
    withdrawOwnerAtCompletion: () => { ownerReads = 0; withdrawOwnerOnRead = 2; },
    onOwnerRead: (fn: (count: number) => void | Promise<void>) => { ownerRead = fn; },
    onObjectRead: (fn: () => void) => { objectRead = fn; } };
}

async function refused(promise: Promise<unknown>, code: StructureNativeBasisProblem['code'],
  status: StructureNativeBasisProblem['status']) {
  try { await promise; }
  catch (error) {
    expect(error).toBeInstanceOf(StructureNativeBasisProblem);
    expect((error as StructureNativeBasisProblem).code).toBe(code);
    expect((error as StructureNativeBasisProblem).status).toBe(status);
    return;
  }
  throw new Error(`Expected refusal ${code}`);
}

test('an acknowledged Structure use preserves its real receipt, repeated identity, ordering and exact immutable values', async () => {
  const f = await fixture(), writes = f.writes();
  const first = await readAcknowledgedStructureOccurrence(f.session(), f.basis);
  const second = await readAcknowledgedStructureOccurrence(f.session(), { ...f.basis, occurrence: f.second });
  expect(first.native).toEqual(f.basis);
  expect(first.record).toEqual(f.records[1]!);
  expect(second.record).toEqual(f.records[2]!);
  expect(first.record.qualifier).toEqual(second.record.qualifier);
  expect(first.record.occurrence).not.toBe(second.record.occurrence);
  expect(first.path).toEqual([f.records[0]!]);
  expect(f.receipts.get(f.basis.receipt)).toEqual(first.commandReceipt);
  expect(first.operation).toBe(f.operations.get(f.basis.receipt)!);
  expect(first.manifest).toBe(f.header().manifest);
  expect(first.sourcePosition).toEqual({ datasetId: 'product', dataEpoch: 'structure-epoch', sequence: '1' });
  expect(first.headGuarantee).toBe('verified-before-commit');
  first.record.sourceKey = 'client mutation'; first.path[0]!.labels = [];
  expect((await readAcknowledgedStructureOccurrence(f.session(), f.basis)).record).toEqual(f.records[1]!);
  expect(f.writes()).toBe(writes);
});

test('the same native acknowledgement reader uses the registered Book owner without Recipe classification', async () => {
  const f = await fixture('book-composition');
  const result = await readAcknowledgedStructureOccurrence(f.session(), f.basis);
  expect(result.record).toEqual(f.records[0]!);
  expect(result.path).toEqual([]);
  expect(result.commandReceipt.receipt).toBe(compositionReceiptIri(result.commandReceipt.admissionId, 'work.edit'));
});

test('an acknowledged episode retains repeated uses but a later target type change cannot borrow its historical command', async () => {
  const f = await fixture('episode-list-v1');
  const original = await readAcknowledgedStructureOccurrence(f.session(), f.basis);
  const repeated = await readAcknowledgedStructureOccurrence(f.session(), { ...f.basis, occurrence: f.second });
  expect(original.record).toEqual(f.records[1]!);
  expect(repeated.record).toEqual(f.records[2]!);
  expect(original.path).toEqual([f.records[0]!]);
  expect(original.record.target).toBe(f.episode);
  expect(repeated.record.target).toBe(original.record.target);
  expect(repeated.record.occurrence).not.toBe(original.record.occurrence);
  await f.setTargetTypes(['https://schema.org/Movie']);
  const writes = f.writes();
  await refused(readAcknowledgedStructureOccurrence(f.session(), f.basis), 'structure_target_mismatch', 422);
  expect(f.header().head).toBe(f.basis.revision);
  expect(f.receipts.get(f.basis.receipt)).toEqual(original.commandReceipt);
  expect(f.writes()).toBe(writes);
  const probes = f.queries.filter(query => query.includes('SELECT ?target WHERE'));
  expect(probes.length).toBeGreaterThan(0);
  expect(probes.every(query => query.includes(`<${f.episode}>`) && query.endsWith('LIMIT 1'))).toBe(true);
});

test('a target grain change during acknowledgement refuses the current use without replacing a child', async () => {
  const f = await fixture('episode-list-v1'), writes = f.writes();
  f.onTargetCheck(count => {
    if (count === 2) f.targetTypes(['https://schema.org/TVEpisode', 'https://schema.org/CreativeWork']);
  });
  await refused(readAcknowledgedStructureOccurrence(f.session(), f.basis), 'structure_target_mismatch', 422);
  expect(f.targetChecks()).toBe(2);
  expect(f.receipts.size).toBe(1);
  expect(f.writes()).toBe(writes);
});

test('the caller final fence rechecks the native target profile after returning an acknowledged child', async () => {
  const f = await fixture('episode-list-v1'), session = f.session();
  const original = await readAcknowledgedStructureOccurrence(session, f.basis);
  await session.fenceDependencies();
  const checks = f.targetChecks();
  f.targetTypes(['https://schema.org/Movie']);
  await expect(session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
  expect(f.targetChecks()).toBeGreaterThan(checks);
  expect(f.receipts.get(f.basis.receipt)).toEqual(original.commandReceipt);
});

test('a missing current target owner remains unavailable and an undisclosed revision is refused before target probing', async () => {
  const f = await fixture('episode-list-v1'), writes = f.writes();
  f.targetUnavailable(true);
  await refused(readAcknowledgedStructureOccurrence(f.session(), f.basis), 'structure_basis_unavailable', 503);
  const checks = f.targetChecks();
  f.disclosed(false);
  await refused(readAcknowledgedStructureOccurrence(f.session(), f.basis), 'structure_basis_denied', 403);
  expect(f.targetChecks()).toBe(checks);
  expect(f.receipts.size).toBe(1);
  expect(f.writes()).toBe(writes);
});

test('a disclosed target without a semantic head still reaches the independent native grain guard', async () => {
  const f = await fixture('episode-list-v1');
  f.targetTypes(['https://schema.org/TVEpisode', 'https://schema.org/CreativeWork']);
  f.targetHead(undefined);
  const writes = f.writes(), receipt = structuredClone(f.receipts.get(f.basis.receipt));
  await refused(readAcknowledgedStructureOccurrence(f.session(), f.basis), 'structure_target_mismatch', 422);
  expect(f.targetChecks()).toBe(1);
  const probes = f.queries.filter(query => query.includes('SELECT DISTINCT ?target ?head'));
  expect(probes).toHaveLength(1);
  expect(probes[0]).toContain(`VALUES ?target { <${f.episode}> }`);
  expect(probes[0]).toContain('OPTIONAL { GRAPH');
  expect(probes[0]!.trim()).toEndWith('LIMIT 2');
  expect(f.receipts.get(f.basis.receipt)).toEqual(receipt);
  expect(f.receipts.size).toBe(1);
  expect(f.writes()).toBe(writes);
});

for (const movement of ['summary', 'head', 'absent-head'] as const) {
  test(`closing ${movement} movement preserves a currently disclosed native profile mismatch`, async () => {
    const f = await fixture('episode-list-v1'), receipt = structuredClone(f.receipts.get(f.basis.receipt));
    let writes = f.writes();
    f.onOwnerRead(async count => {
      if (count !== 2) return;
      if (movement === 'summary') await f.setTargetTypes(['https://schema.org/Movie']);
      else {
        f.targetTypes(['https://schema.org/Movie']);
        f.targetHead(movement === 'head' ? derivedId('changed-target-head') : undefined);
      }
      writes = f.writes();
    });
    await refused(readAcknowledgedStructureOccurrence(f.session(), f.basis), 'structure_target_mismatch', 422);
    expect(f.targetChecks()).toBe(2);
    expect(f.header().head).toBe(f.basis.revision);
    expect(f.receipts.get(f.basis.receipt)).toEqual(receipt);
    expect(f.receipts.size).toBe(1);
    expect(f.writes()).toBe(writes);
  });
}

test('target withdrawal during a moved closing read refuses disclosure before reporting its invalid profile', async () => {
  const f = await fixture('episode-list-v1'), writes = f.writes();
  f.onOwnerRead(count => {
    if (count !== 2) return;
    f.targetReadable(false);
    f.targetTypes(['https://schema.org/Movie']);
    f.targetHead(derivedId('withheld-target-head'));
  });
  await refused(readAcknowledgedStructureOccurrence(f.session(), f.basis), 'structure_basis_denied', 403);
  expect(f.targetChecks()).toBe(1);
  expect(f.receipts.size).toBe(1);
  expect(f.writes()).toBe(writes);
});

test('a valid moved target cannot replace the opening acknowledgement selection', async () => {
  const f = await fixture('episode-list-v1'), writes = f.writes();
  f.onOwnerRead(count => { if (count === 2) f.targetHead(derivedId('new-valid-target-head')); });
  await expect(readAcknowledgedStructureOccurrence(f.session(), f.basis)).rejects.toMatchObject({
    status: 503, code: 'structure_basis_unavailable', cause: expect.any(WorkReadMoved),
  });
  expect(f.targetChecks()).toBe(2);
  expect(f.receipts.size).toBe(1);
  expect(f.writes()).toBe(writes);
});

test('unavailable native evidence after closing target movement cannot become a profile mismatch', async () => {
  const f = await fixture('episode-list-v1'), writes = f.writes();
  f.onOwnerRead(count => {
    if (count !== 2) return;
    f.targetHead(derivedId('unavailable-target-head'));
    f.targetUnavailable(true);
  });
  await refused(readAcknowledgedStructureOccurrence(f.session(), f.basis), 'structure_basis_unavailable', 503);
  expect(f.targetChecks()).toBe(2);
  expect(f.receipts.size).toBe(1);
  expect(f.writes()).toBe(writes);
});

test('the caller final fence retains the exact selected target head as well as its native profile', async () => {
  const f = await fixture('episode-list-v1'), session = f.session(), writes = f.writes();
  const original = await readAcknowledgedStructureOccurrence(session, f.basis);
  await session.fenceDependencies();
  f.targetHead(derivedId('post-acknowledgement-target-head'));
  await expect(session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
  expect(f.receipts.get(f.basis.receipt)).toEqual(original.commandReceipt);
  expect(f.receipts.size).toBe(1);
  expect(f.writes()).toBe(writes);
});

test('a command receipt cannot be replaced by the Structure, revision, child or an uncommitted new intent', async () => {
  const f = await fixture(), writes = f.writes();
  for (const receipt of [f.basis.structure, f.basis.revision, f.first]) {
    await refused(readAcknowledgedStructureOccurrence(f.session(), { ...f.basis, receipt }), 'structure_receipt_mismatch', 422);
  }
  await refused(readAcknowledgedStructureOccurrence(f.session(), { ...f.basis,
    receipt: compositionReceiptIri('never-committed', 'recipe.edit') }), 'structure_basis_unavailable', 503);
  await refused(readAcknowledgedStructureOccurrence(f.session(), { ...f.basis, component: derivedId('other-main') }),
    'structure_target_mismatch', 422);
  expect(f.writes()).toBe(writes);
});

test('cancelled, wrong-owner, wrong-revision and wrong-scope receipts never certify an occurrence', async () => {
  const f = await fixture(), receipt = f.receipts.get(f.basis.receipt)!, original = structuredClone(receipt);
  const alternatives: Partial<CompositionTerminal>[] = [{ outcome: 'cancelled' }, { structure: derivedId('other-structure') },
    { revision: derivedId('other-revision') }, { scope: 'work:edit:other' },
    { owner: derivedId('other-owner') }, { component: derivedId('other-component') },
    { authorityEpoch: '' }, { requestDigest: '' }];
  for (const alternative of alternatives) {
    f.receipts.set(f.basis.receipt, { ...original, ...alternative });
    await refused(readAcknowledgedStructureOccurrence(f.session(), f.basis), 'structure_receipt_mismatch', 422);
  }
  f.receipts.set(f.basis.receipt, original);
  expect(original).toEqual((await readAcknowledgedStructureOccurrence(f.session(), f.basis)).commandReceipt);
});

test('the actual operation, revision model and source position must agree with the native terminal receipt', async () => {
  const f = await fixture(), revision = f.revisions.get(f.basis.revision)!;
  f.operations.delete(f.basis.receipt);
  await refused(readAcknowledgedStructureOccurrence(f.session(), f.basis), 'structure_basis_unavailable', 503);
  f.operations.set(f.basis.receipt, derivedId('wrong-operation'));
  await refused(readAcknowledgedStructureOccurrence(f.session(), f.basis), 'structure_basis_unavailable', 503);
  f.operations.set(f.basis.receipt, revision.operation);
  revision.model = 'https://rezics.com/definition/other';
  await refused(readAcknowledgedStructureOccurrence(f.session(), f.basis), 'structure_basis_unavailable', 503);
  revision.model = COMPOSITION_PROFILE; revision.sequence = '99';
  await refused(readAcknowledgedStructureOccurrence(f.session(), f.basis), 'structure_basis_unavailable', 503);
  revision.sequence = '1'; revision.dataEpoch = 'another-epoch';
  await refused(readAcknowledgedStructureOccurrence(f.session(), f.basis), 'structure_basis_unavailable', 503);
});

test('committed replay preserves its child and receipt; a human edit needs a new exact acknowledgement', async () => {
  const f = await fixture(), writes = f.writes();
  const original = await readAcknowledgedStructureOccurrence(f.session(), f.basis);
  const replay = await readAcknowledgedStructureOccurrence(f.session(), f.basis);
  expect(replay.native).toEqual(original.native);
  expect(replay.commandReceipt).toEqual(original.commandReceipt);
  expect(f.writes()).toBe(writes);
  const changed = structuredClone(f.records);
  changed[1]!.orderKey = 'c'; changed[1]!.labels = [{ value: 'Human correction', language: 'en' }];
  const next = await f.install(changed);
  await refused(readAcknowledgedStructureOccurrence(f.session(), f.basis), 'structure_head_mismatch', 409);
  const current = await readAcknowledgedStructureOccurrence(f.session(), next);
  expect(current.record.occurrence).toBe(original.record.occurrence);
  expect(current.record.orderKey).toBe('c');
  expect(current.record.labels).toEqual(changed[1]!.labels);
  expect(current.commandReceipt.receipt).toBe(next.receipt);
  expect(f.receipts.get(f.basis.receipt)).toEqual(original.commandReceipt);
});

test('retirement after a successful acknowledgement is not repaired by replacing the exact repeated use', async () => {
  const f = await fixture();
  const acknowledged = await readAcknowledgedStructureOccurrence(f.session(), f.basis);
  const changed = structuredClone(f.records), retired = changed[1]!;
  retired.state = 'removed'; retired.removedBy = derivedId('human-retirement');
  delete retired.orderKey; delete retired.segmentKey;
  const next = await f.install(changed), writes = f.writes();
  await refused(readAcknowledgedStructureOccurrence(f.session(), f.basis), 'structure_head_mismatch', 409);
  await refused(readAcknowledgedStructureOccurrence(f.session(), next), 'structure_occurrence_retired', 409);
  const independent = await readAcknowledgedStructureOccurrence(f.session(), { ...next, occurrence: f.second });
  expect(independent.record).toEqual(changed[2]!);
  expect(f.receipts.get(f.basis.receipt)).toEqual(acknowledged.commandReceipt);
  expect(f.writes()).toBe(writes);
});

test('missing and corrupt immutable snapshots or a missing exact active order entry stay unavailable', async () => {
  const missing = await fixture(), digest = missing.header().manifest.slice(-64);
  missing.bytes.delete(digest);
  await refused(readAcknowledgedStructureOccurrence(missing.session(), missing.basis), 'structure_basis_unavailable', 503);
  const corrupt = await fixture();
  corrupt.bytes.set(corrupt.header().manifest.slice(-64), new TextEncoder().encode('{}'));
  await refused(readAcknowledgedStructureOccurrence(corrupt.session(), corrupt.basis), 'structure_basis_unavailable', 503);
  const unindexed = await fixture();
  const ordered = unindexed.records.filter(record => record.occurrence !== unindexed.first).map(record => ({
    occurrence: record.occurrence, parent: record.parent,
    segmentKey: record.segmentKey!, orderKey: record.orderKey!,
  }));
  const basis = await unindexed.install(unindexed.records, ordered);
  await refused(readAcknowledgedStructureOccurrence(unindexed.session(), basis), 'structure_basis_unavailable', 503);
  await refused(readAcknowledgedStructureOccurrence(unindexed.session(), { ...basis, occurrence: derivedId('absent-use') }),
    'structure_basis_unavailable', 503);
});

test('an orphan or cycle cannot substitute for the immutable occurrence parent path', async () => {
  for (const parent of ['absent', 'cycle', 'leaf'] as const) {
    const f = await fixture(), records = structuredClone(f.records);
    records[0]!.parent = parent === 'absent' ? derivedId('absent-parent') : parent === 'cycle' ? f.group : f.second;
    const basis = await f.install(records);
    await refused(readAcknowledgedStructureOccurrence(f.session(), basis), 'structure_basis_unavailable', 503);
  }
});

test('denied, inactive and withdrawn owner or exact-revision disclosure never become successful acknowledgements', async () => {
  const f = await fixture(), writes = f.writes();
  f.active(false);
  await refused(readAcknowledgedStructureOccurrence(f.session(), f.basis), 'structure_basis_denied', 403);
  f.active(true); f.readable(false);
  await refused(readAcknowledgedStructureOccurrence(f.session(), f.basis), 'structure_basis_denied', 403);
  f.readable(true); f.disclosed(false);
  await refused(readAcknowledgedStructureOccurrence(f.session(), f.basis), 'structure_basis_denied', 403);
  f.disclosed(true); f.withdrawOwnerAtCompletion();
  await refused(readAcknowledgedStructureOccurrence(f.session(), f.basis), 'structure_basis_denied', 403);
  expect(f.writes()).toBe(writes);
});

test('a head change during verification is refused and a later change fails the caller final selection fence', async () => {
  const moving = await fixture();
  moving.onObjectRead(() => { moving.header().head = derivedId('concurrent-head'); });
  await refused(readAcknowledgedStructureOccurrence(moving.session(), moving.basis), 'structure_head_mismatch', 409);
  const stable = await fixture(), session = stable.session();
  await readAcknowledgedStructureOccurrence(session, stable.basis);
  await session.fenceDependencies();
  stable.header().head = derivedId('later-head');
  await expect(session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
});

test('closing disclosure and principal checks retain the same session instead of borrowing a prior success', async () => {
  const f = await fixture(), session = f.session();
  await readAcknowledgedStructureOccurrence(session, f.basis);
  f.disclosed(false);
  await expect(session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
  f.disclosed(true); f.active(false);
  await expect(session.fenceAuthority()).rejects.toThrow('Principal is inactive');
});

test('a missing terminal receipt remains unavailable while its historical acknowledgement and other child remain intact', async () => {
  const f = await fixture(), original = await readAcknowledgedStructureOccurrence(f.session(), f.basis);
  f.terminalAvailable(false);
  await refused(readAcknowledgedStructureOccurrence(f.session(), f.basis), 'structure_basis_unavailable', 503);
  f.terminalAvailable(true);
  expect(f.receipts.get(f.basis.receipt)).toEqual(original.commandReceipt);
  expect((await readAcknowledgedStructureOccurrence(f.session(), { ...f.basis, occurrence: f.second })).record)
    .toEqual(f.records[2]!);
});

test('an unfenced moving inventory or a non-Work Structure cannot inherit an exact Work acknowledgement', async () => {
  const f = await fixture(), moving = f.session();
  moving.options.movingGraph = true;
  await refused(readAcknowledgedStructureOccurrence(moving, f.basis), 'structure_basis_unavailable', 503);
  f.header().profile = 'collection-membership';
  await refused(readAcknowledgedStructureOccurrence(f.session(), { ...f.basis, profile: 'collection-membership' }),
    'structure_basis_unavailable', 503);
});

test('the selected child and revision disclosure cannot be changed through mutable input during immutable hydration', async () => {
  const f = await fixture(), supplied = structuredClone(f.basis);
  f.onObjectRead(() => { supplied.occurrence = f.second; });
  expect((await readAcknowledgedStructureOccurrence(f.session(), supplied)).native).toEqual(f.basis);
  f.onObjectRead(() => { f.disclosed(false); });
  await refused(readAcknowledgedStructureOccurrence(f.session(), f.basis), 'structure_basis_denied', 403);
});
