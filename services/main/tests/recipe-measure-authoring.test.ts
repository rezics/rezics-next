import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { FusekiClient, type CommandEnvelope, type CommandResult, type SparqlResult }
  from '../src/infrastructure/fuseki.ts';
import type { ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { AdmissionDenied, type RegisteredAdmission } from '../src/modules/access/admission.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { IdempotencyConflict, RV, hash } from '../src/modules/work/activate.ts';
import { compositionReceiptIri, orderTree, recordTree } from '../src/modules/structure/change.ts';
import { derivedId } from '../src/modules/structure/graph.ts';
import { newCost } from '../src/modules/structure/tree.ts';
import { STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT, STRUCTURE_PROFILE,
  checkStructureManifest, type RecipeMeasure, type StructureManifest }
  from '../src/modules/structure/format.ts';
import { recipeRoutes } from '../src/routes/recipes.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';

const work = derivedId('measure-authoring-work'), main = derivedId('measure-authoring-main');
const structure = derivedId('measure-authoring-structure'), actor = derivedId('measure-authoring-actor');
const initialHead = derivedId('measure-authoring-initial'), workHead = derivedId('measure-authoring-work-head');
const generation = derivedId('measure-authoring-generation');
const term = (value: string) => ({ type: 'literal', value });
const uri = (value: string) => ({ type: 'uri', value });
type Row = NonNullable<SparqlResult['results']>['bindings'][number];
const rows = (bindings: Row[]): SparqlResult => ({ results: { bindings } });
const yieldInput = { value: { numerator: 4, denominator: 1 }, unitText: 'servings',
  coverage: 'complete', provenance: 'declared' } as const;
const servingInput = { value: { numerator: 4, denominator: 1 },
  coverage: 'complete', provenance: 'declared' } as const;
const timing: RecipeMeasure = { kind: 'cooking-duration', value: { numerator: 15, denominator: 1 },
  unitText: 'minutes', basis: 'whole-recipe', coverage: 'unknown', provenance: 'source-stated',
  evidence: 'https://example.test/retained-recipe' };
// Controlled values exercise the native contract; these are not a retained public corpus.
const nutrients: RecipeMeasure[] = [
  { kind: 'nutrient', nutrient: 'https://schema.org/calories', unit: 'https://example.test/kcal',
    value: { numerator: 169, denominator: 1 }, valueLexical: '169', basis: 'per-serving',
    coverage: 'unknown', provenance: 'source-stated', evidence: 'https://example.test/panel' },
  { kind: 'nutrient', nutrient: 'https://schema.org/calciumContent', unit: 'https://example.test/mg',
    value: { numerator: 5, denominator: 16 }, basis: 'per-serving',
    coverage: 'partial', provenance: 'computed', evidence: 'https://example.test/reference#page=150' },
  { kind: 'nutrient', nutrient: 'https://schema.org/calories', unit: 'https://example.test/kcal',
    value: { numerator: 1352, denominator: 2 }, basis: 'whole-recipe',
    coverage: 'complete', provenance: 'declared', evidence: 'https://example.test/independent' },
  { kind: 'nutrient', nutrient: 'https://schema.org/calories', unit: 'https://example.test/kcal',
    value: { numerator: 338, denominator: 2 }, basis: 'per-serving',
    coverage: 'unknown', provenance: 'source-stated', evidence: 'https://example.test/second-panel' },
];

async function fixture() {
  const bytes = new Map<string, Uint8Array>();
  const objects: ImmutableObjects = {
    put: async value => { const digest = hash(value); bytes.set(digest, value.slice()); return digest; },
    get: async digest => { const value = bytes.get(digest); if (!value) throw new Error('Missing fixture object'); return value.slice(); },
  };
  const cost = newCost();
  const manifest: StructureManifest = { format: STRUCTURE_MANIFEST_FORMAT, structure, structureOf: main,
    profile: 'recipe-composition', generation, pageFormat: STRUCTURE_PAGE_FORMAT,
    records: await recordTree(objects).empty(cost), order: await orderTree(objects).empty(cost),
    placementCount: 0, measures: [timing], model: STRUCTURE_PROFILE, shape: STRUCTURE_PROFILE };
  const versions = new Map([[initialHead, { manifest: `urn:rezics:sha256:${await objects.put(
    new TextEncoder().encode(JSON.stringify(manifest)))}`, sequence: '1', predecessor: null as string | null }]]);
  const admissions = new Map<string, RegisteredAdmission>(), receipts = new Map<string, Row>();
  const state = { head: initialHead, sequence: 1, writes: 0, dispatches: 0, authorized: true,
    authenticated: true, readable: true, visible: true, measureReads: 0, hideAfterMeasureRead: false,
    cancel: false, expired: false, loseReply: false, admissions: 0 };
  let current: RegisteredAdmission | undefined;
  const graph = new class extends FusekiClient {
    constructor() { super('http://fixture.invalid/rezics'); }
    override async commandHealth() {
      return { moduleVersion: 'fixture', instanceId: 'fixture', publicSearchWriteEpoch: '1',
        publicSearchWriteActive: false,
        profiles: Object.fromEntries(Object.entries(profileRegistry).map(([id, profile]) => [id, profile.sha256])) };
    }
    override async query(query: string): Promise<SparqlResult> {
      const control = { epoch: term('measure-epoch'), sequence: term(String(state.sequence)) };
      if (query.includes('ASK')) return { boolean: !query.includes('rv:InvalidProfile') };
      if (query.includes('SELECT ?outcome ?reason ?kind')) {
        const receipt = query.match(/<(?<receipt>urn:rezics:receipt:[a-f0-9]+)>/)?.groups?.receipt;
        return rows(receipt && receipts.has(receipt) ? [receipts.get(receipt)!] : []);
      }
      if (query.includes('SELECT ?component ?profile ?head')) return rows([{
        component: uri(main), profile: uri(`${RV}RecipeComposition`), head: uri(state.head),
        generation: uri(generation), count: term('0'), manifest: uri(versions.get(state.head)!.manifest),
      }]);
      if (query.includes('SELECT ?owner')) return rows([{ owner: uri(work) }]);
      if (query.includes('SELECT ?manifest ?predecessor')) {
        state.measureReads++;
        if (state.hideAfterMeasureRead) state.visible = false;
        const revision = query.match(/<(https:\/\/rezics.com\/id\/[a-f0-9-]+)> a rv:StructureRevision/)?.[1];
        const version = revision && versions.get(revision);
        return rows(version ? [{ manifest: uri(version.manifest), count: term('0'),
          epoch: term('measure-epoch'), sequence: term(version.sequence),
          ...(version.predecessor ? { predecessor: uri(version.predecessor) } : {}) }] : []);
      }
      if (query.includes('SELECT ?head ?main ?mainHead')) return rows([{ head: uri(workHead), main: uri(main),
        mainHead: uri(main), public: term('false'), type: uri('https://schema.org/Recipe') }]);
      if (query.includes('SELECT ?structuredDecision')) return rows([]);
      if (query.includes('SELECT ?structure WHERE')) return rows([{ structure: uri(structure) }]);
      if (query.includes('SELECT ?work ?parent')) return rows([{ work: uri(work) }]);
      if (query.includes('SELECT ?work ?head ?owningWork')) return rows([{ work: uri(work),
        head: uri(workHead), owningWork: uri(work), owningHead: uri(workHead) }]);
      if (query.includes('SELECT ?resource ?head')) return rows([{ resource: uri(work), head: uri(workHead) }]);
      if (query.includes('SELECT ?epoch ?sequence ?hold ?r')) return rows([{ ...control,
        r: uri(work), head: uri(workHead), type: term('work'), work: uri(work), public: term('false'),
        label: { ...term('Controlled Recipe'), 'xml:lang': 'en' } }]);
      if (query.includes('SELECT ?epoch ?sequence')) return rows([control]);
      throw new Error(`Unexpected measure owner query: ${query}`);
    }
    override async commandWithReceipt(envelope: CommandEnvelope): Promise<CommandResult> {
      state.dispatches++;
      const admission = current;
      if (!admission) throw new Error('Command lacks an admission');
      expect(envelope.digest).toBe(admission.requestDigest);
      expect(envelope.receipt).toBe(compositionReceiptIri(admission.id, 'recipe.edit'));
      expect(admission.scope).toBe(`work:edit:${work}`);
      expect(envelope.update).toContain('rv:restoreHold true');
      const prior = receipts.get(envelope.receipt);
      if (prior) return { status: 'committed', position: {
        datasetId: 'fixture', dataEpoch: prior.dataEpoch!.value, sequence: prior.sequence!.value,
      } };
      const cancelled = envelope.update.includes('rv:outcome rv:Cancelled');
      const expected = envelope.update.match(/rv:expectedHead <([^>]+)>/)?.[1];
      if (!cancelled && expected !== state.head) return { status: 'guard-unmatched' };
      let revision: string | undefined;
      if (!cancelled) {
        expect(envelope.validations.length).toBeGreaterThan(0);
        expect(envelope.update).toContain(`rv:structureHead <${state.head}>`);
        expect(envelope.update).toContain(`rv:selectedGeneration <${generation}>`);
        revision = envelope.update.match(/rv:structureRevision <([^>]+)>/)?.[1];
        const root = envelope.update.match(/rv:manifest <([^>]+)>/)?.[1];
        if (!revision || !root) throw new Error('Measure command lacks immutable revision/root');
        const saved = checkStructureManifest(await objects.get(root.slice(-64)));
        expect(saved.records).toEqual(manifest.records);
        expect(saved.order).toEqual(manifest.order);
        versions.set(revision, { manifest: root, sequence: String(state.sequence + 1), predecessor: state.head });
        state.head = revision;
        state.writes++;
      }
      state.sequence++;
      receipts.set(envelope.receipt, { outcome: uri(`${RV}${cancelled ? 'Cancelled' : 'Succeeded'}`),
        digest: term(admission.requestDigest), admission: term(admission.id), epoch: term(admission.authorityEpoch),
        scope: term(admission.scope), dataEpoch: term('measure-epoch'), sequence: term(String(state.sequence)),
        ...(cancelled && envelope.update.includes('rv:reason rv:StaleHead') ? { reason: uri(`${RV}StaleHead`) } : {}),
        ...(!cancelled ? { structure: uri(structure), revision: uri(revision!), expected: uri(expected!) } : {}),
      });
      if (state.loseReply) { state.loseReply = false; throw new Error('Committed response lost'); }
      return { status: 'committed', position: {
        datasetId: 'fixture', dataEpoch: 'measure-epoch', sequence: String(state.sequence),
      } };
    }
  }();
  const assertAuthority = async () => { if (!state.authorized) throw new AdmissionDenied('Recipe edit denied'); };
  const deps = { environment: { fuseki: graph, lineage: { dataEpoch: 'measure-epoch', routingEpoch: 'routing' },
    objectDirectory: '.temp/recipe-measure-authoring', structureObjects: objects }, structureObjects: objects,
    account: { verify: async () => {
      if (!state.authenticated) throw new AdmissionDenied('Account denied');
      return { issuer: 'account', subject: 'editor', emailVerified: true };
    } },
    access: { assertAuthority, assertRecoveryOpen: async () => {}, activePrincipalId: async () => 'editor',
      canReadWork: async () => state.readable, canPreviewWork: async () => state.readable,
      register: async (input: { requestDigest: string; idempotencyKey: string; scope: string; action: string; actingSubject: string }) => {
        await assertAuthority();
        expect(input.actingSubject).toBe(actor);
        expect(input.action).toBe('recipe.edit');
        expect(input.scope).toBe(`work:edit:${work}`);
        const prior = admissions.get(input.idempotencyKey);
        if (prior && prior.requestDigest !== input.requestDigest) throw new IdempotencyConflict('Changed measure retry');
        current = prior ?? { ...input, id: randomUUID(), authorityEpoch: '1', principalId: 'editor',
          state: 'registered', dispatchEligible: !state.cancel, replayed: false,
          expiresAt: state.expired ? '2000-01-01T00:00:00Z' : '2999-01-01T00:00:00Z' };
        if (!prior) { admissions.set(input.idempotencyKey, current); state.admissions++; }
        return current;
      },
      claim: async () => {
        if (!current) throw new Error('Missing registered admission');
        current.state = 'claimed'; return current;
      },
      recordGraphOutcome: async () => { if (current) current.state = 'sealed'; },
    },
  } as unknown as MainWorkDependencies;
  configureFixtureDisclosureAncestry(deps.environment, target => target.work
    ? { resource: work, head: workHead, protectedRevision: target.workRevision } : undefined);
  configureDisclosure(deps.environment, fixtureDisclosureReader(async targets => {
    return targets.map(() => state.visible ? 'visible' : 'hidden');
  }));
  const app = recipeRoutes(graph, deps);
  const post = (body: object, key = randomUUID(), endpoint = 'measures') => app.handle(new Request(
    `http://localhost/v1/recipes/${structure.slice(-36)}/${endpoint}`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key, authorization: 'Bearer editor' },
      body: JSON.stringify(body) }));
  const calculate = (body: object) => app.handle(new Request('http://localhost/v1/recipes/nutrition', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer editor' },
    body: JSON.stringify(body),
  }));
  const get = (path: string) => app.handle(new Request(`http://localhost${path}`, {
    headers: { authorization: 'Bearer editor' } }));
  const body = (extra: object = {}, head = state.head) => ({ expectedHead: head, actingSubject: actor,
    yield: yieldInput, servings: servingInput, ...extra });
  const measures = async (revision = state.head): Promise<RecipeMeasure[]> => {
    const version = versions.get(revision)!;
    return checkStructureManifest(await objects.get(version.manifest.slice(-64))).measures;
  };
  return { state, post, get, calculate, body, measures, versions, receipts };
}

test('native nutrient rows round-trip through the admitted revision and both Recipe reads without relabelling', async () => {
  const f = await fixture(), before = await f.measures(), original = structuredClone(nutrients);
  const response = await f.post(f.body({ nutrients }));
  expect(response.status).toBe(200);
  const written = await response.json();
  expect(written).toMatchObject({ structure, revision: f.state.head, replayed: false });
  expect(written.receipt).toMatch(/^urn:rezics:receipt:/);
  const stored = await f.measures();
  expect(stored.filter(item => item.kind === 'nutrient')).toEqual(original);
  expect(stored).toContainEqual(timing);
  expect(await f.measures(initialHead)).toEqual(before);
  const read = await f.get(`/v1/recipes/${structure.slice(-36)}/measures?actingSubject=${actor}&revision=${written.revision}`);
  expect(read.status).toBe(200);
  expect((await read.json()).measures).toEqual(stored);
  const page = await f.get(`/v1/recipes/works/${work.slice(-36)}?actingSubject=${actor}&revision=${written.revision}`);
  expect(page.status).toBe(200);
  expect((await page.json()).measures).toEqual(stored);
  const scaled = await f.get(`/v1/recipes/works/${work.slice(-36)}?actingSubject=${actor}&revision=${written.revision}&servings=8`);
  expect(scaled.status).toBe(200);
  const result = (await scaled.json()).measures as RecipeMeasure[];
  expect(result.filter(item => item.kind === 'nutrient' && item.basis === 'per-serving'))
    .toEqual(original.filter(item => item.basis === 'per-serving'));
  expect(result.find(item => item.kind === 'nutrient' && item.basis === 'whole-recipe')?.value)
    .toEqual({ numerator: 1352, denominator: 1 });
  expect(nutrients).toEqual(original);
  expect(f.state.writes).toBe(1);
});

test('omission preserves native nutrients, explicit empty clears, and timing edits preserve both', async () => {
  const f = await fixture();
  expect((await f.post(f.body({ nutrients }))).status).toBe(200);
  expect((await f.post(f.body())).status).toBe(200);
  expect((await f.measures()).filter(item => item.kind === 'nutrient')).toEqual(nutrients);
  expect((await f.post({ expectedHead: f.state.head, actingSubject: actor,
    preparation: { ...yieldInput, unitText: 'minutes', evidence: 'https://example.test/prep' } },
  randomUUID(), 'timings')).status).toBe(200);
  expect((await f.measures()).filter(item => item.kind === 'nutrient')).toEqual(nutrients);
  expect((await f.post(f.body({ nutrients: [] }))).status).toBe(200);
  expect((await f.measures()).filter(item => item.kind === 'nutrient')).toEqual([]);
  expect(await f.measures()).toContainEqual(timing);
  expect((await f.measures()).some(item => item.kind === 'preparation-duration')).toBe(true);
});

test('absolute citation IRIs finish one native command and retain exact rows through replay and both reads', async () => {
  const f = await fixture(), key = randomUUID();
  const row = { ...nutrients[0]!, nutrient: 'urn:recipe:nutrient/energy#panel', unit: 'qudt:KiloCAL',
    evidence: 'doi:10.1000/182' };
  const intent = f.body({ nutrients: [row, { ...row, evidence: 'tag:example.test,2026:panel/é?part=2#row' }] });
  const response = await f.post(intent, key);
  expect(response.status).toBe(200);
  const written = await response.json();
  expect(written.receipt).toMatch(/^urn:rezics:receipt:/);
  expect(written.revision).toBe(f.state.head);
  expect(f.state.admissions).toBe(1);
  expect(f.state.dispatches).toBe(1);
  expect(f.state.writes).toBe(1);
  expect(f.receipts.size).toBe(1);
  expect(f.versions.size).toBe(2);
  const stored = await f.measures();
  expect(stored.filter(item => item.kind === 'nutrient')).toEqual(intent.nutrients);
  for (const path of [`/v1/recipes/${structure.slice(-36)}/measures`, `/v1/recipes/works/${work.slice(-36)}`]) {
    const read = await f.get(`${path}?actingSubject=${actor}&revision=${written.revision}`);
    expect(read.status).toBe(200);
    expect((await read.json()).measures).toEqual(stored);
  }
  const replay = await f.post(intent, key);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ receipt: written.receipt, revision: written.revision, replayed: true });
  expect(f.state.admissions).toBe(1);
  expect(f.state.dispatches).toBe(1);
  expect(f.state.writes).toBe(1);
  expect(f.receipts.size).toBe(1);
  expect(f.versions.size).toBe(2);
});

test('unsafe RDF references refuse before admission and leave the request key available for valid input', async () => {
  const f = await fixture(), key = randomUUID();
  for (const field of ['nutrient', 'unit', 'evidence'] as const) {
    for (const reference of ['doi:10.1000/182>', 'doi:10.1000/"182', 'doi:10.1000/{182}',
      'doi:10.1000/\\u003e', 'doi:10.1000/\u0000', 'doi:10.1000/%ZZ', 'doi:10.1000/\ud800']) {
      const response = await f.post(f.body({ nutrients: [{ ...nutrients[0], [field]: reference }] }), key);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'invalid_recipe_change' });
      expect(f.state.admissions).toBe(0);
      expect(f.state.dispatches).toBe(0);
      expect(f.state.writes).toBe(0);
      expect(f.state.head).toBe(initialHead);
      expect(f.receipts.size).toBe(0);
      expect(f.versions.size).toBe(1);
    }
  }
  expect((await f.post(f.body({ nutrients: [{ ...nutrients[0], evidence: 'doi:10.1000/182' }] }), key)).status).toBe(200);
  expect(f.state.admissions).toBe(1);
  expect(f.state.writes).toBe(1);
});

test('yield and timing reference refusals also happen before admission', async () => {
  const f = await fixture();
  for (const unit of ['doi:10.1000/182>', 'doi:10.1000/\\u003e']) {
    for (const response of [await f.post(f.body({ yield: { ...yieldInput, unit } })),
      await f.post({ expectedHead: initialHead, actingSubject: actor,
        cooking: { ...yieldInput, unit } }, randomUUID(), 'timings')]) {
      expect(response.status).toBe(422);
      expect(f.state.admissions).toBe(0);
      expect(f.state.dispatches).toBe(0);
      expect(f.state.writes).toBe(0);
      expect(f.state.head).toBe(initialHead);
      expect(f.receipts.size).toBe(0);
      expect(f.versions.size).toBe(1);
    }
  }
});

test('existing calculation requests and the explicit calculator retain exact aggregation and truthful coverage', async () => {
  const f = await fixture();
  expect((await f.post(f.body({ nutrients }))).status).toBe(200);
  const nutrition = { basis: 'per-serving', inputs: [
    { coverage: 'complete', values: [{ nutrient: 'https://schema.org/calories',
      unit: 'https://example.test/kcal', amount: { numerator: 1, denominator: 2 } }] },
    { coverage: 'partial', values: [{ nutrient: 'https://schema.org/calories',
      unit: 'https://example.test/kcal', amount: { numerator: 3, denominator: 2 } }] },
  ] };
  const calculated = await f.calculate(nutrition);
  expect(calculated.status).toBe(200);
  expect(await calculated.json()).toMatchObject({ basis: 'per-serving', coverage: 'partial',
    nutrients: [{ nutrient: 'https://schema.org/calories', unit: 'https://example.test/kcal',
      amount: { numerator: 2, denominator: 1 } }] });
  expect(f.state.writes).toBe(1);
  expect((await f.post(f.body({ nutrition }))).status).toBe(200);
  expect((await f.measures()).filter(item => item.kind === 'nutrient')).toEqual([{ kind: 'nutrient',
    nutrient: 'https://schema.org/calories', unit: 'https://example.test/kcal',
    value: { numerator: 2, denominator: 1 }, basis: 'per-serving', coverage: 'partial', provenance: 'computed' }]);
  expect((await f.post(f.body({ nutrition: { basis: 'per-serving', inputs: [] } }))).status).toBe(200);
  expect((await f.measures()).filter(item => item.kind === 'nutrient')).toEqual([]);
});

test('mixed forms, malformed native rows and oversized final sets refuse before any native revision', async () => {
  const f = await fixture();
  for (const [extra, status] of [
    [{ nutrients: [], nutrition: { basis: 'per-serving', inputs: [] } }, 400],
    [{ nutrients: [{ ...nutrients[0], kind: 'servings' }] }, 422],
    [{ nutrients: [{ ...nutrients[0], value: { numerator: 1, denominator: 0 } }] }, 422],
    [{ nutrients: [{ ...nutrients[0], coverage: 'invented' }] }, 422],
    [{ nutrients: [{ ...nutrients[0], evidence: 'not a URI' }] }, 422],
    [{ nutrients: [{ ...nutrients[0], unit: undefined }] }, 422],
    [{ nutrients: [{ ...nutrients[0], nutrient: undefined }] }, 422],
    [{ nutrients: Array.from({ length: 64 }, () => nutrients[0]) }, 400],
  ] as const) {
    const response = await f.post(f.body(extra));
    expect(response.status).toBe(status);
    expect(f.state.writes).toBe(0);
    expect(f.state.head).toBe(initialHead);
    expect(f.receipts.size).toBe(0);
    expect(f.state.admissions).toBe(0);
  }
});

test('committed lost-reply replay preserves the original receipt; a stale new intent cannot create a child revision', async () => {
  const f = await fixture(), key = randomUUID(), intent = f.body({ nutrients });
  f.state.loseReply = true;
  const first = await f.post(intent, key);
  expect(first.status).toBe(200);
  const committed = await first.json();
  expect((await f.post(f.body({ nutrients: [] }))).status).toBe(200);
  const head = f.state.head;
  const replay = await f.post(intent, key);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ receipt: committed.receipt, revision: committed.revision, replayed: true });
  expect(f.state.head).toBe(head);
  expect((await f.post(intent)).status).toBe(409);
  expect(f.state.head).toBe(head);
  expect(f.state.writes).toBe(2);
  expect(f.versions.size).toBe(3);
  expect([...f.receipts.values()].filter(item => item.reason?.value === `${RV}StaleHead`)).toHaveLength(1);
  expect((await f.post({ ...intent, nutrients: [] }, key)).status).toBe(409);
  expect(f.state.writes).toBe(2);
});

test('evidence grants no edit authority, including replay after revocation', async () => {
  const f = await fixture(), key = randomUUID(), intent = f.body({ nutrients });
  f.state.authorized = false;
  expect((await f.post(intent, key)).status).toBe(403);
  expect(f.state.admissions).toBe(0);
  expect(f.state.writes).toBe(0);
  f.state.authorized = true;
  expect((await f.post(intent, key)).status).toBe(200);
  f.state.authorized = false;
  expect((await f.post(intent, key)).status).toBe(403);
  expect(f.state.writes).toBe(1);
});

test('cancelled and expired admissions never publish a native measure revision', async () => {
  for (const mode of ['cancel', 'expired'] as const) {
    const f = await fixture();
    f.state[mode] = true;
    const response = await f.post(f.body({ nutrients }));
    expect(response.status).toBe(mode === 'cancel' ? 503 : 202);
    expect(f.state.head).toBe(initialHead);
    expect(f.state.writes).toBe(0);
    expect(f.versions.size).toBe(1);
  }
});

test('current disclosure denial prevents either measure read from publishing the stored evidence', async () => {
  const f = await fixture();
  expect((await f.post(f.body({ nutrients }))).status).toBe(200);
  f.state.visible = false;
  for (const path of [`/v1/recipes/${structure.slice(-36)}/measures`, `/v1/recipes/works/${work.slice(-36)}`]) {
    const response = await f.get(`${path}?actingSubject=${actor}`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('https://example.test/panel');
  }
});

test('withdrawal after native measure hydration is refused by the closing disclosure fence', async () => {
  const f = await fixture();
  expect((await f.post(f.body({ nutrients }))).status).toBe(200);
  const before = f.state.measureReads;
  f.state.hideAfterMeasureRead = true;
  const response = await f.get(`/v1/recipes/${structure.slice(-36)}/measures?actingSubject=${actor}`);
  expect(f.state.measureReads).toBeGreaterThan(before);
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('https://example.test/panel');
  expect(f.state.writes).toBe(1);
});
