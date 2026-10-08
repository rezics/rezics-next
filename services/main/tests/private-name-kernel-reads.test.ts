import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { configureDisclosure, DisclosureStore, type DisclosureTarget } from '../src/modules/disclosure/read.ts';
import { disclosureViewer, withDisclosureViewer } from '../src/modules/disclosure/viewer.ts';
import { discloseExportPlan, readExportPlan } from '../src/modules/export/readers.ts';
import { planExport } from '../src/modules/export/planner.ts';
import { readResourceSummaries } from '../src/modules/media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../src/modules/media/store.ts';
import { querySearchFields } from '../src/modules/search/fields.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';
import { referenceDisclosure } from '../src/modules/target/disclosed-references.ts';
import { PROFILES } from '../src/modules/semantic/schema.ts';
import { prepareComponent, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { discloseParticipantName, participantReadName } from '../src/modules/work/read-contract.ts';
import { disclosedRelationParticipations, relationRoutes } from '../src/routes/relations.ts';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const privateAgent = id(1);
const publicAgent = id(2);
const publicWork = id(3);
const concept = id(4);
const character = id(5);
const controller: VerifiedPrincipal = { issuer: 'account', subject: 'controller' };
const stranger: VerifiedPrincipal = { issuer: 'account', subject: 'stranger' };
const privateName = 'Private Pen';
const publicName = 'Public Author';
const shownName = { value: privateName, language: 'en', direction: 'ltr' as const, basis: 'fallback' as const };
const directory = mkdtempSync('.temp/private-name-kernel-');
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const uri = (value: string) => ({ type: 'uri' as const, value });
const literal = (value: string) => ({ type: 'literal' as const, value });
type Row = NonNullable<SparqlResult['results']>['bindings'][number];

function iris(query: string) {
  return [...new Set([...query.matchAll(/<https:\/\/rezics\.com\/id\/[0-9a-f-]{36}>/g)].map(match => match[0].slice(1, -1)))];
}

function nameVisible(owner: string | null, issuer: unknown, subject: unknown, published: boolean) {
  return owner == null || owner === publicAgent || owner === publicWork || owner === concept
    || (owner === privateAgent && (published || (issuer === controller.issuer && subject === controller.subject)));
}

/** Anonymous classification of the same name. A controller grant does not make it public. */
function publicNameVisible(owner: string | null, published: boolean) {
  return nameVisible(owner, null, null, published);
}

function policyGraph(summary: (query: string) => Row[] | null, manifest?: string) {
  let published = false;
  const graph = new FusekiClient('http://graph.invalid');
  const queries: string[] = [];
  graph.query = async query => {
    queries.push(query);
    if (query.includes('ASK')) return { boolean: true };
    if (query.includes('rv:provisional')) return { results: { bindings: [] } };
    if (query.includes('?manifest') && manifest) return { results: { bindings: [{
      type: uri(`${RV}SemanticRevision`), manifest: uri(`urn:rezics:sha256:${manifest}`),
      generation: literal('urn:rezics:model-generation:test'), epoch: literal('epoch'), sequence: literal('1'),
    }] } };
    const summarized = summary(query);
    if (summarized) return { results: { bindings: summarized } };
    if (query.includes('?nameOwner') || query.includes('?owningWork') || query.includes('SELECT ?work ?head WHERE')) {
      return { results: { bindings: iris(query).map(work => ({ work: uri(work), head: uri(id(11)),
        ...(query.includes('?nameOwner') && (work === privateAgent || work === publicAgent)
          ? { nameOwner: uri(work) } : {}) })) } };
    }
    if (query.includes('SELECT ?epoch ?sequence WHERE')) {
      return { results: { bindings: [{ epoch: literal('epoch'), sequence: literal('1') }] } };
    }
    throw new Error(`unexpected graph query: ${query.slice(0, 240)}`);
  };
  const pool = { query: async (sql: string, args?: unknown[]) => {
    if (!sql.includes('requested AS')) return { rows: [] };
    const targets = JSON.parse(String(args?.[0])) as (DisclosureTarget & { ordinal: number; nameOwner: string | null })[];
    return { rows: targets.map(target => ({ ordinal: target.ordinal, open: true, restricted: false, assessments: [],
      nameVisible: nameVisible(target.nameOwner, args?.[4], args?.[5], published),
      publicNameVisible: publicNameVisible(target.nameOwner, published) })) };
  } } as unknown as Pool;
  const environment = { fuseki: graph, objectDirectory: directory,
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } } as WorkActivationEnvironment;
  configureDisclosure(environment, new DisclosureStore(pool));
  return { environment, queries, publish: () => { published = true; } };
}

const control = { epoch: literal('epoch'), sequence: literal('1') };

test('a relation keeps a readable participant when only the credited name is withheld', async () => {
  const closed = policyGraph(() => null);
  const role = id(20);
  const occurrence = id(21);
  const participations = [
    { iri: occurrence, role, participant: { kind: 'resource' as const, ref: privateAgent },
      creditedName: { lexical: privateName, language: 'en' } },
    { iri: id(22), role, participant: { kind: 'external' as const, provider: 'open-library', namespace: 'author', key: 'OL1A' },
      creditedName: { lexical: 'Reported Name', language: 'en' } },
    { iri: id(23), role, participant: { kind: 'resource' as const, ref: character },
      creditedName: { lexical: 'Public Character', language: 'en' } },
    { iri: id(24), role, participant: { kind: 'resource' as const, ref: concept },
      creditedName: { lexical: 'Public Concept', language: 'en' } },
    { iri: id(25), role, participant: { kind: 'resource' as const, ref: publicAgent },
      creditedName: { lexical: publicName, language: 'en' } },
  ];
  const readable = new Set([privateAgent, character, concept, publicAgent]);
  const withheld = await disclosedRelationParticipations(closed.environment, participations, readable, { [role]: 'author' },
    ANONYMOUS_VIEWER);
  expect(withheld[0]).toMatchObject({ participant: { kind: 'resource', ref: privateAgent }, availability: 'available',
    creditedName: { reference: privateAgent, status: 'unavailable' } });
  expect(JSON.stringify(withheld[0])).not.toContain(privateName);
  expect(withheld[1]?.creditedName).toEqual({ lexical: 'Reported Name', language: 'en' });
  expect(withheld[2]?.creditedName).toEqual({ lexical: 'Public Character', language: 'en' });
  expect(withheld[3]?.creditedName).toEqual({ lexical: 'Public Concept', language: 'en' });
  expect(withheld[4]?.creditedName).toEqual({ lexical: publicName, language: 'en' });
  const hidden = await disclosedRelationParticipations(closed.environment,
    participations, readable, { [role]: 'author' }, disclosureViewer(stranger));
  expect(hidden[0]?.creditedName).toEqual({ reference: privateAgent, status: 'unavailable' });
  expect(hidden[0]?.participant).toEqual({ kind: 'resource', ref: privateAgent });
  const shown = await disclosedRelationParticipations(closed.environment,
    participations, readable, { [role]: 'author' }, disclosureViewer(controller));
  expect(shown[0]?.creditedName).toEqual({ lexical: privateName, language: 'en' });
  const absent = await disclosedRelationParticipations(closed.environment,
    participations, new Set(), { [role]: 'author' }, disclosureViewer(controller));
  expect(absent[0]).toMatchObject({ participant: { kind: 'unavailable-reference' }, availability: 'unavailable' });
  expect(absent[0]).not.toHaveProperty('creditedName');
  closed.publish();
  const published = await disclosedRelationParticipations(closed.environment,
    participations, readable, { [role]: 'author' }, disclosureViewer(stranger));
  expect(published[0]?.creditedName).toEqual({ lexical: privateName, language: 'en' });
});

test('both relation reads preserve private Agent identities and public non-Agent credits', async () => {
  const definition = id(60), definitionRevision = id(61), occurrence = id(62), revision = id(63);
  const denied = id(64);
  const definitionDigest = prepareComponent(directory, definition, {
    component: 'definition', kind: 'relation', lifecycle: 'active', successor: null,
    roles: [{ key: 'member', minParticipants: 1, maxParticipants: 4, ordered: false,
      members: [privateAgent, character, concept, denied] }],
  }, PROFILES.definition);
  const occurrenceDigest = prepareComponent(directory, occurrence, {
    definition: definitionRevision, lifecycle: 'active', applicability: [],
    participations: [privateAgent, character, concept, denied].map((ref, index) => ({
      iri: id(70 + index), role: `${definition}/role/member`, participant: { kind: 'resource', ref },
      creditedName: { lexical: ref === privateAgent ? privateName : ref === character ? 'Public Character'
        : ref === concept ? 'Public Concept' : 'Denied Credit', language: 'en' },
    })),
  }, PROFILES.relation);
  const closed = policyGraph(query => {
    if (query.includes('SELECT ?head ?manifest WHERE')) return [{ head: uri(revision),
      manifest: uri(`urn:rezics:sha256:${occurrenceDigest}`) }];
    if (query.includes('SELECT ?p ?o WHERE')) return [
      { p: uri('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), o: uri(`${RV}RelationOccurrence`) },
      { p: uri(`${RV}relationDefinition`), o: uri(definitionRevision) },
      { p: uri(`${RV}occurrenceHead`), o: uri(revision) },
    ];
    if (query.includes('SELECT ?manifest ?predecessor ?epoch ?sequence')) return [{ ...control,
      manifest: uri(`urn:rezics:sha256:${occurrenceDigest}`) }];
    if (query.includes('SELECT ?definition ?manifest')) return [{ definition: uri(definition),
      manifest: uri(`urn:rezics:sha256:${definitionDigest}`) }];
    // No target summary: readable semantic resources exercise the identity fallback.
    if (query.includes('?hold')) return [control];
    return null;
  });
  let principal = stranger;
  const work = { environment: closed.environment, account: { verify: async () => principal },
    access: { canReadSemanticResource: async (_principal: unknown, _acting: string, resource: string) => resource !== denied,
      canReadWork: async () => false } } as unknown as MainWorkDependencies;
  const app = relationRoutes(closed.environment.fuseki, work);
  for (const suffix of ['', `/revisions/${revision.slice(-36)}`]) {
    for (principal of [stranger, controller]) {
      const response = await app.handle(new Request(`http://main.test/v1/relations/${occurrence.slice(-36)}${suffix}`
        + `?actingSubject=${encodeURIComponent(id(9))}&position=all`));
      expect(response.status).toBe(200);
      const read = await response.json();
      expect(read.definition.roles[0].members).toEqual([privateAgent, character, concept].sort());
      expect(read.participations[0]).toMatchObject({ participant: { kind: 'resource', ref: privateAgent },
        availability: 'available', creditedName: principal === controller
          ? { lexical: privateName, language: 'en' } : { reference: privateAgent, status: 'unavailable' } });
      expect(read.participations[1]).toMatchObject({ participant: { kind: 'resource', ref: character },
        availability: 'available', creditedName: { lexical: 'Public Character', language: 'en' } });
      expect(read.participations[2].creditedName).toEqual({ lexical: 'Public Concept', language: 'en' });
      expect(read.participations[3]).toMatchObject({ participant: { kind: 'unavailable-reference' }, availability: 'unavailable' });
      expect(read.participations[3]).not.toHaveProperty('creditedName');
      expect(JSON.stringify(read)).not.toContain('Denied Credit');
      if (principal === stranger) expect(JSON.stringify(read)).not.toContain(privateName);
    }
  }
});

test('a withheld participant name keeps the reference and uses the unavailable shape', async () => {
  const hidden = await discloseParticipantName(undefined, privateAgent, shownName, ANONYMOUS_VIEWER);
  expect(hidden).toEqual({ reference: privateAgent, status: 'unavailable' });
  expect(Value.Check(participantReadName, hidden)).toBe(true);
  expect(JSON.stringify(hidden)).not.toContain(privateName);
  const strangerHidden = await discloseParticipantName({ visibleNameOwners: async () => new Set() },
    privateAgent, shownName, disclosureViewer(stranger));
  expect(strangerHidden).toEqual({ reference: privateAgent, status: 'unavailable' });
  const shown = await discloseParticipantName({
    visibleNameOwners: async agents => new Set(agents),
  }, privateAgent, shownName, disclosureViewer(controller));
  expect(shown).toEqual(shownName);
  expect(Value.Check(participantReadName, shown)).toBe(true);
});

test('semantic readability does not restore a private name', async () => {
  const open = { fuseki: new FusekiClient('http://graph.invalid'), objectDirectory: directory,
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } } as WorkActivationEnvironment;
  open.fuseki.query = async query => query.includes('?hold')
    ? { results: { bindings: [control] } }
    : query.includes('SELECT ?epoch ?sequence WHERE')
      ? { results: { bindings: [control] } }
      : { results: { bindings: [] } };
  const canRead = async () => true;
  expect([...(await referenceDisclosure(open, { principal: stranger, actingSubject: id(9), access: {} }, canRead)(
    [privateAgent, concept]))]).toEqual([privateAgent, concept]);
  const closed = policyGraph(query => query.includes('?hold') ? [control] : null);
  const strangerRefs = await referenceDisclosure(closed.environment,
    { principal: stranger, actingSubject: id(9), access: {} }, canRead)([privateAgent, concept]);
  expect(strangerRefs.has(concept)).toBe(true);
  expect(strangerRefs.has(privateAgent)).toBe(false);
  const anonymousRefs = await referenceDisclosure(closed.environment, {}, canRead)([privateAgent, concept]);
  expect([...anonymousRefs]).toEqual([concept]);
  const controllerRefs = await referenceDisclosure(closed.environment,
    { principal: controller, actingSubject: id(9), access: {} }, canRead)([privateAgent, concept]);
  expect(controllerRefs.has(privateAgent)).toBe(true);
  expect(controllerRefs.has(concept)).toBe(true);
});

test('an export keeps the carrying resource when a copied private name is withheld', async () => {
  const closed = policyGraph(() => null);
  const data = { resource: publicWork, name: privateName, nameOwner: privateAgent,
    participant: { kind: 'resource', ref: privateAgent },
    creditedName: { lexical: privateName, language: 'en' },
    agent: privateAgent, displayName: privateName };
  const plan = await planExport({ targetProfile: 'private-name-portable-v1', useScope: 'full', residuals: [],
    members: [{ sourceOwner: 'graph', sourceNamespace: 'product', sourceGrain: 'external_release',
      exactRef: publicWork, contentRevisionId: null, refDigest: 'a'.repeat(64), ownerDataEpoch: 'epoch',
      ownerSequence: '1', sourcePosition: null, targetGrain: 'Work', mapping: 'exact', data,
      value: { kind: 'text', lexical: privateName, language: null } }] }, async () => []);
  const hidden = await discloseExportPlan(closed.environment, plan, ANONYMOUS_VIEWER);
  expect(JSON.stringify(hidden)).not.toContain(privateName);
  expect(JSON.stringify(hidden)).toContain(publicWork);
  expect(hidden.members[0]?.data).toMatchObject({ resource: publicWork,
    name: { reference: privateAgent, status: 'unavailable' },
    creditedName: { reference: privateAgent, status: 'unavailable' },
    displayName: { reference: privateAgent, status: 'unavailable' } });
  expect(hidden.members[0]).not.toHaveProperty('value');
  const shown = await discloseExportPlan(closed.environment, plan, disclosureViewer(controller));
  expect(JSON.stringify(shown)).toContain(privateName);
  expect(shown.members[0]?.data).toMatchObject({ name: privateName, resource: publicWork });
  const own = await planExport({ targetProfile: 'private-name-portable-v1', useScope: 'full', residuals: [],
    members: [{ sourceOwner: 'graph', sourceNamespace: 'product', sourceGrain: 'external_release',
      exactRef: privateAgent, contentRevisionId: null, refDigest: 'b'.repeat(64), ownerDataEpoch: 'epoch',
      ownerSequence: '1', sourcePosition: null, targetGrain: 'Agent', mapping: 'exact',
      data: { work: privateAgent, name: privateName } }] }, async () => []);
  const omitted = await discloseExportPlan(closed.environment, own, disclosureViewer(stranger));
  expect(omitted.members[0]?.data).toEqual({ omitted: 'disclosure_restricted' });
  expect(JSON.stringify(omitted)).not.toContain(privateName);
  const retained = await discloseExportPlan(closed.environment, own, disclosureViewer(controller));
  expect(JSON.stringify(retained)).toContain(privateName);
  const title = await planExport({ targetProfile: 'private-name-portable-v1', useScope: 'full', residuals: [],
    members: [{ sourceOwner: 'graph', sourceNamespace: 'product', sourceGrain: 'external_release',
      exactRef: publicWork, contentRevisionId: null, refDigest: 'c'.repeat(64), ownerDataEpoch: 'epoch',
      ownerSequence: '1', sourcePosition: null, targetGrain: 'Work', mapping: 'exact',
      data: { resource: publicWork, title: 'Public Title' } }] }, async () => []);
  expect(await discloseExportPlan(closed.environment, title, ANONYMOUS_VIEWER)).toBe(title);
});

test('a semantic export does not serialize a private name the semantic reader can read', async () => {
  const digest = prepareComponent(directory, privateAgent, { component: 'resource', lifecycle: 'active',
    types: [`${RV}Character`], properties: [{ predicate: 'https://schema.org/name',
      value: { kind: 'language-string', lexical: privateName, language: 'en' } }] }, PROFILES.resource);
  const closed = policyGraph(() => null, digest);
  const selection = { kind: 'semantic-revision' as const, reference: id(30), resource: privateAgent,
    expectedPosition: { dataEpoch: 'epoch', sequence: '1' } };
  const deps = { env: closed.environment, canReadWork: async () => true, canReadSemantic: async () => true,
    platformAccess: { require: async () => {} } };
  const hidden = await readExportPlan(deps, stranger, id(9), selection, 'full');
  expect(JSON.stringify(hidden)).not.toContain(privateName);
  const shown = await readExportPlan(deps, controller, id(9), selection, 'full');
  expect(JSON.stringify(shown)).toContain(privateName);
});

test('search does not match a withheld credit and keeps the agent on a visible one', async () => {
  let credited = { agent: privateAgent, text: privateName };
  const row = (): Row => ({ epoch: literal('epoch'), sequence: literal('1'), work: uri(publicWork),
    main: uri(id(40)), unit: uri(id(41)), contribution: uri(id(42)), revision: uri(id(43)),
    selection: uri(id(44)), language: literal('en'), field: literal('credit'),
    text: { ...literal(credited.text), 'xml:lang': 'en' }, agent: uri(credited.agent) });
  const open = { fuseki: new FusekiClient('http://graph.invalid'), objectDirectory: directory,
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } } as WorkActivationEnvironment;
  open.fuseki.query = async query => {
    if (query.includes('?field')) {
      expect(query).toMatch(/SELECT DISTINCT[\s\S]*\?agent WHERE/);
      return { results: { bindings: [row()] } };
    }
    if (query.includes('SELECT ?epoch ?sequence WHERE')) return { results: { bindings: [control] } };
    throw new Error(`unexpected open search query: ${query.slice(0, 160)}`);
  };
  const position = { dataEpoch: 'epoch', sequence: '1' };
  const admitted = await querySearchFields(open, { phrase: 'private', language: null }, position);
  expect(admitted.map(match => [match.matchedText, match.nameOwner])).toEqual([[privateName, privateAgent]]);
  const closed = policyGraph(query => query.includes('?field') ? [row()] : null);
  expect(await querySearchFields(closed.environment, { phrase: 'private', language: null }, position)).toEqual([]);
  expect(await withDisclosureViewer(disclosureViewer(controller), () =>
    querySearchFields(closed.environment, { phrase: 'private', language: null }, position))).toEqual([]);
  credited = { agent: publicAgent, text: publicName };
  const visible = await querySearchFields(closed.environment, { phrase: 'public', language: null }, position);
  expect(visible.map(match => [match.matchedText, match.nameOwner])).toEqual([[publicName, publicAgent]]);
  credited = { agent: privateAgent, text: privateName };
  closed.publish();
  const published = await querySearchFields(closed.environment, { phrase: 'private', language: null }, position);
  expect(published.map(match => match.matchedText)).toEqual([privateName]);
  expect(JSON.stringify(await querySearchFields(closed.environment, { phrase: 'private', language: null }, position)))
    .toContain(privateName);
});

test('an authorized private-name summary is restricted, and an anonymous one stays unavailable', async () => {
  const agentRow = (): Row => ({ ...control, r: uri(privateAgent), type: literal('agent'), public: literal('true'),
    label: literal(privateName) });
  const publicRow = (): Row => ({ ...control, r: uri(publicAgent), type: literal('agent'), public: literal('true'),
    label: literal(publicName) });
  const bare = { fuseki: new FusekiClient('http://graph.invalid'), objectDirectory: directory,
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } } as WorkActivationEnvironment;
  bare.fuseki.query = async () => ({ results: { bindings: [publicRow()] } });
  const unconfigured = await readResourceSummaries(bare, undefined, {}, {
    resources: [publicAgent], context: DEFAULT_MEDIA_CONTEXT, language: 'en' });
  expect(unconfigured.summaries[0]).toMatchObject({ status: 'available', disclosure: 'public',
    name: { value: publicName } });
  expect(unconfigured.cost.graphQueries).toBe(1);
  let kind: 'private' | 'public' = 'private';
  const closed = policyGraph(query => query.includes('?hold') ? [kind === 'private' ? agentRow() : publicRow()] : null);
  const input = { context: DEFAULT_MEDIA_CONTEXT, language: 'en' as const };
  const anonymous = await readResourceSummaries(closed.environment, undefined, {},
    { ...input, resources: [privateAgent] });
  expect(anonymous.summaries).toEqual([{ reference: privateAgent, status: 'unavailable' }]);
  expect(JSON.stringify(anonymous)).not.toContain(privateName);
  expect(anonymous.cost.graphQueries).toBe(2);
  const authorized = await readResourceSummaries(closed.environment, undefined,
    { viewer: disclosureViewer(controller) }, { ...input, resources: [privateAgent] });
  expect(authorized.summaries[0]).toMatchObject({ reference: privateAgent, status: 'available', type: 'agent',
    disclosure: 'restricted', name: { value: privateName } });
  // The paired owner statement classifies the anonymous name in the same batch,
  // so the separate name-owner probe is not a fourth graph query.
  expect(authorized.cost.graphQueries).toBe(3);
  kind = 'public';
  const published = await readResourceSummaries(closed.environment, undefined, {},
    { ...input, resources: [publicAgent] });
  expect(published.summaries[0]).toMatchObject({ status: 'available', disclosure: 'public',
    name: { value: publicName } });
  const projection = id(50);
  const projected = policyGraph(query => {
    if (!query.includes('?hold')) return null;
    const refs = iris(query);
    const bindings: Row[] = [];
    if (refs.includes(projection)) bindings.push({ ...control, r: uri(projection), type: literal('projection'),
      public: literal('true'), projectionSubject: uri(privateAgent), projectionFrame: uri(concept) });
    if (refs.includes(privateAgent)) bindings.push(agentRow());
    if (refs.includes(concept)) bindings.push({ ...control, r: uri(concept), type: literal('concept'),
      public: literal('true'), label: { ...literal('Idea'), 'xml:lang': 'en' } });
    return bindings.length ? bindings : [control];
  });
  const hiddenProjection = await readResourceSummaries(projected.environment, undefined, {},
    { ...input, resources: [projection] });
  expect(hiddenProjection.summaries).toEqual([{ reference: projection, status: 'unavailable' }]);
  expect(JSON.stringify(hiddenProjection)).not.toContain(privateName);
  const shownProjection = await readResourceSummaries(projected.environment, undefined,
    { viewer: disclosureViewer(controller) }, { ...input, resources: [projection] });
  expect(shownProjection.summaries[0]).toMatchObject({ status: 'available', type: 'projection',
    disclosure: 'restricted', name: { value: privateName } });
});
