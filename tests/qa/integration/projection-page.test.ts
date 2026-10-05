import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';
import { startMediaStack, type MediaStack } from './media-support.ts';
import { seedCanonicity, seedVariantKindConcepts, seedRelationLexicon, type SeedLexiconClient } from '../../../scripts/dev/seed/relation-lexicon.ts';
import { CANONICITY_PROPERTY, relationLexiconSeed } from '../../../scripts/dev/seed/relation-lexicon-data.ts';
import { entityPage, subjectStatementPage, resourceRelationPage } from '../../../services/main/src/modules/entity-page/contract.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { ReadingPositionStore } from '../../../services/main/src/modules/reading-position/store.ts';
import { GRAPHS, iri, activateMetadataWork, metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { selectMainDefault, mainSelectionDigest } from '../../../services/main/src/modules/work/select-main.ts';
import { readDefinitionByKey } from '../../../services/main/src/modules/relation/change.ts';
import { systemDisclosure } from '../../../services/main/src/modules/target/disclosed-references.ts';
import type { RealizationWrite } from '../../../services/main/src/modules/realization/schema.ts';
import type { ReleaseV2Write } from '../../../services/main/src/modules/release/schema.ts';

const RV = 'https://rezics.com/vocab/';
const short = (ref: string) => ref.slice(-36);
const namespace = `pp-${randomUUID()}`;
type StatementPage = Static<typeof subjectStatementPage>;
type RelationPage = Static<typeof resourceRelationPage>;
type Member = Awaited<ReturnType<MediaStack['member']>>;
let stack: MediaStack, owner: Member;
let work: Awaited<ReturnType<MediaStack['publicWork']>>;
let subject: string, canon: string, legends: string, chapter: string, later: string, projection: string;
// Two volumes with a chapter each, and a release and realization of the Book; `foreign` lies in another Work.
let volumeOne: string, volumeTwo: string, inVolume: string, inOtherVolume: string, edition: { release: string; realization: string };
let foreign: { work: string; chapter: string; release: string };
let relation: { component: string; revision: string };
let vocabulary: Awaited<ReturnType<typeof seedCanonicity>>;

const seedClient: SeedLexiconClient = {
  post: async <T>(path: string, body: object, key: string) => {
    // Vocabulary identities are shared by a QA project; each run still creates
    // its own Concept schemes and never replaces another file's property head.
    if (path === '/v1/semantic/changes' && 'state' in body
      && (body.state as { notation?: string }).notation === 'canonicity') {
      const rows = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?component ?revision WHERE {
        GRAPH ${iri(GRAPHS.current)} { ?key a rv:DefinitionKey ; rv:keyDefinition ?component ;
          <http://www.w3.org/2004/02/skos/core#notation> "canonicity" .
          ?component a rv:SemanticDefinition ; rv:definitionHead ?revision }
      } LIMIT 2`)).results?.bindings ?? [];
      if (rows.length > 1) throw new Error('Canonicity definition key is ambiguous');
      if (rows[0]) return { component: rows[0].component!.value, revision: rows[0].revision!.value } as T;
    }
    return json<T>(await owner.send('POST', path, body, key), 201);
  },
  authorizeDefinition: async definition => {
    await owner.grant(`semantic:read:${definition.component}`, 'semantic.read');
    await owner.grant(`semantic:edit:${definition.component}`, 'lexicon.presentation.change');
  },
};

async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`${response.status}, expected ${status}: ${text}`);
  return JSON.parse(text) as T;
}
const semantic = async (name: string, type: string) => (await json<{ component: string }>(await owner.send(
  'POST', '/v1/semantic/changes', { profile: 'semantic-change-v1', expectedHead: null, actingSubject: owner.actor,
    state: { component: 'resource', types: [type], properties: [
      { predicate: 'https://schema.org/name', value: { kind: 'language-string', lexical: name, language: 'en' } },
      { predicate: `${RV}semanticWork`, value: { kind: 'resource', ref: work.work } },
    ] } }), 201)).component;
const project = async (frames: string[]) => (await json<{ projection: { id: string } }>(await owner.send('POST', '/v1/projections',
  { subject, frames, actingSubject: owner.actor }), 201)).projection.id;
const frameQuery = (frames: string[]) => frames.map(frame => `&frame=${encodeURIComponent(frame)}`).join('');
const readStatements = async (frames: string[] = [], extra = '') => json<StatementPage>(await owner.read(
  `/v1/resources/${short(subject)}/statements?limit=20${frameQuery(frames)}${extra}`));
const ids = (page: StatementPage) => page.groups.flatMap(group => group.items)
  .flatMap(item => item.kind === 'statement' ? [item.statement] : []);
async function statement(applicability: string[], on = subject, key = randomUUID(), value?: object) {
  return json<{ statement: string; revision: string; meaningKey: string }>(await owner.send('POST', '/v1/statements',
    { profile: 'statement-v1', speaker: { kind: 'personal' }, subject: on,
      predicate: value ? CANONICITY_PROPERTY : 'https://example.org/fact',
      relationDefinition: value ? vocabulary.definition.revision : 'https://example.org/meaning',
      value: value ?? { kind: 'literal', lexical: key, datatype: 'http://www.w3.org/2001/XMLSchema#string', language: null },
      applicability, interpretation: { kind: 'selected' }, evidence: [], actingSubject: owner.actor }, key), 201);
}
async function accept(saved: { statement: string }) {
  await json(await owner.send('POST', '/v1/statement-decisions', { profile: 'statement-decision-v1',
    target: { kind: 'statement', statement: saved.statement }, acceptance: { kind: 'global' },
    expectedDecisionHead: null, outcome: 'accepted', actingSubject: owner.actor }), 201);
}
async function occurrence(applicability: string[], participant = subject) {
  const result = await json<{ occurrence: string }>(await owner.send('POST', '/v1/relations/changes',
    { profile: 'relation-change-v1', expectedHead: null, definition: relation.revision, participations: [
      { role: 'subject', participant: { kind: 'resource', ref: participant } },
      { role: 'counterpart', participant: { kind: 'resource', ref: canon } },
    ], applicability, actingSubject: owner.actor }), 201);
  await owner.grant(`semantic:read:${result.occurrence}`, 'semantic.read');
  return result.occurrence;
}

const id = () => `https://rezics.com/id/${randomUUID()}`;
/** A public Book the owner may read and edit. */
async function publish(title: string) {
  const semanticTypes = ['https://schema.org/Book'];
  const created = await activateMetadataWork(stack.env, { title, semanticTypes,
    admission: stack.admission(owner.actor, 'work:create:root', 'work.create', metadataWorkRequestDigest(title, semanticTypes)) });
  const contribution = await stack.contribution(created.work, owner.actor, 'en', title);
  const selection = { context: { kind: 'main-version-default' as const, id: created.mainVersion }, work: created.work,
    contribution: contribution.contribution, publicationDecision: contribution.decision, expectedSelectionHead: null,
    selectionBasis: 'main-maintainer' as const, actingSubject: owner.actor };
  await selectMainDefault(stack.env, stack.admission(owner.actor, `publication:select:${created.mainVersion}`,
    'publication.select', mainSelectionDigest(selection)), selection);
  for (const [scope, action] of [[`work:read:${created.work}`, 'work.read'], [`work:edit:${created.work}`, 'work.edit']] as const) {
    await owner.grant(scope, action);
  }
  return { ...created, title, variants: [contribution] };
}
/** One realization and one release covering it, written through the owner commands. */
async function publishEdition(on: string) {
  const root = `/v1/works/${on.slice(-36)}`;
  const body: RealizationWrite = { profile: 'realization-v1', expectedHead: null, actingSubject: owner.actor, id: id(),
    language: 'en', kind: 'translation', translators: [owner.actor], publishers: [owner.actor],
    source: { kind: 'unresolved', work: on }, status: 'official', verification: 'verified', evidence: id() };
  const saved = await json<{ revision: string }>(await owner.send('PUT', `${root}/realizations/${body.id.slice(-36)}`, body));
  const release: ReleaseV2Write = { profile: 'release-v2', expectedHead: null, actingSubject: owner.actor, id: id(),
    kind: 'formal', status: 'official', title: { value: 'Release', language: 'en' }, titleLanguage: 'en',
    tracklistLanguage: null, editionStatement: null, publisher: null, publicationYear: null, isbn13: null,
    originalUrl: null, fixedRelease: null, evidence: null, identifiers: [], platform: 'Windows', territory: 'US',
    coverage: [{ realization: body.id, revision: saved.revision, completeness: 'complete' }] };
  await json(await owner.send('PUT', `${root}/releases/${release.id.slice(-36)}`, release));
  return { release: release.id, realization: body.id };
}

/** The in-continuity relation definition; other files may already have installed the canonical vocabulary, and if this
 * file installs it first it uses the full seed so later readers also get labels. */
async function membershipDefinition() {
  const existing = await readDefinitionByKey(stack.env, 'in-continuity', systemDisclosure);
  const definition = existing ? { component: existing.definition, revision: existing.revision }
    : (await seedRelationLexicon(seedClient, owner.actor, namespace,
      relationLexiconSeed.filter(item => item.key === 'in-continuity')))[0]!;
  await owner.grant(`semantic:read:${definition.component}`, 'semantic.read');
  return definition;
}
const joinContinuity = async (definition: { revision: string }, work: string, continuity: string) =>
  json<{ occurrence: string }>(await owner.send('POST', '/v1/relations/changes', { profile: 'relation-change-v1',
    expectedHead: null, definition: definition.revision, participations: [
      { role: 'work', participant: { kind: 'resource', ref: work } },
      { role: 'continuity', participant: { kind: 'resource', ref: continuity } },
    ], actingSubject: owner.actor }), 201);

beforeAll(async () => {
  stack = await startMediaStack(`projection-page-${namespace.slice(-8)}`);
  owner = await stack.member('scoped-facts');
  work = await publish(`A framed Book ${namespace}`);
  for (const [scope, action] of [
    ['semantic:create:root','semantic.change'], ['projection:create:root','projection.create'],
    ['classification:define:global','classification.proposition.define'],
    [`statement:speak:${owner.actor}`,'statement.record'], ['classification:decide:global','statement.decide'],
    ['relation:create:root','relation.change'],
  ]) await owner.grant(scope!, action!);
  subject = await semantic('One character', `${RV}Character`);
  canon = await semantic('Canon continuity', `${RV}NarrativeContinuity`);
  legends = await semantic('Legends continuity', `${RV}NarrativeContinuity`);
  await seedVariantKindConcepts(seedClient, owner.actor, namespace);
  vocabulary = await seedCanonicity(seedClient, owner.actor, namespace);
  relation = await json(await owner.send('POST', '/v1/semantic/changes', { profile: 'semantic-change-v1',
    expectedHead: null, actingSubject: owner.actor, state: { component: 'definition', kind: 'relation',
      roles: ['subject','counterpart'].map(key => ({ key, minParticipants: 1, maxParticipants: 1, ordered: false })) } }), 201);
  await owner.grant(`semantic:read:${relation.component}`, 'semantic.read');
  const objects = stack.objects('semantic/structure/'); await objects.initialize();
  const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
    media: stack.media, mediaAccess: stack.mediaAccess, structureObjects: objects,
    account: { verify: async () => owner.principal } });
  const command = (path: string, body: object) => app.handle(new Request(`http://main.local${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${owner.token}`, 'idempotency-key': randomUUID(),
      'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const book = async (on: { work: string; mainVersion: string }) => {
    const base = await json<{ structure: string; revision: string }>(await command('/v1/compositions',
      { profile: 'book-composition', work: on.work, mainVersion: on.mainVersion, actingSubject: owner.actor }), 201);
    const change = async (expectedHead: string, operations: object[]) => json<{ revision: string; occurrences: string[] }>(
      await command(`/v1/compositions/${short(base.structure)}/changes`,
        { profile: 'book-composition', expectedHead, actingSubject: owner.actor, operations }));
    const label = (value: string) => ({ value, language: 'en' });
    const chapterOf = (parent: string, value: string) => ({ op: 'insert', role: 'chapter', parent, position: 'last',
      target: 'https://schema.org/DigitalDocument', label: label(value) });
    return { ...base, change, chapterOf, group: (value: string) => ({ op: 'insert', role: 'group', parent: base.structure,
      position: 'last', division: 'volume', label: label(value) }) };
  };
  const main = await book(work);
  const chapters = await main.change(main.revision, [main.chapterOf(main.structure, 'Chapter 1'),
    main.chapterOf(main.structure, 'Chapter 2'), main.group('Volume 1'), main.group('Volume 2')]);
  [chapter, later, volumeOne, volumeTwo] = chapters.occurrences as [string, string, string, string];
  const filled = await main.change(chapters.revision, [main.chapterOf(volumeOne, 'Letter'), main.chapterOf(volumeTwo, 'Station')]);
  [inVolume, inOtherVolume] = filled.occurrences as [string, string];
  edition = await publishEdition(work.work);
  const other = await publish(`Another framed Book ${namespace}`);
  const otherBook = await book(other);
  const otherChapters = await otherBook.change(otherBook.revision, [otherBook.chapterOf(otherBook.structure, 'Elsewhere')]);
  foreign = { work: other.work, chapter: otherChapters.occurrences[0]!, release: (await publishEdition(other.work)).release };
  projection = await project([canon, chapter]);
}, 240_000);
afterAll(async () => { await stack?.stop(); });

test('projection Statement normalization preserves the request on replay and refuses a union beyond eight', async () => {
  const key = randomUUID();
  const saved = await statement([canon], projection, key); await accept(saved);
  const read = await json<{ subject: string; applicability: string[] }>(await owner.read(`/v1/statements/${short(saved.statement)}`));
  expect(read).toMatchObject({ subject, applicability: [canon, chapter].sort() });
  expect(ids(await readStatements())).toContain(saved.statement);
  const response = await owner.send('POST', '/v1/statements', { profile: 'statement-v1', speaker: { kind: 'personal' },
    subject: projection, predicate: 'https://example.org/fact', relationDefinition: 'https://example.org/meaning',
    value: { kind: 'literal', lexical: key, datatype: 'http://www.w3.org/2001/XMLSchema#string', language: null },
    applicability: [canon], interpretation: { kind: 'selected' }, evidence: [], actingSubject: owner.actor }, key);
  expect((await json<{ statement: string }>(response)).statement).toBe(saved.statement);
  const overflow = await owner.send('POST', '/v1/statements', { profile: 'statement-v1', speaker: { kind: 'personal' },
    subject: projection, predicate: 'https://example.org/fact', relationDefinition: 'https://example.org/meaning',
    value: { kind: 'no-value' }, applicability: Array.from({ length: 8 }, () => `https://rezics.com/id/${randomUUID()}`),
    interpretation: { kind: 'selected' }, evidence: [], actingSubject: owner.actor });
  expect(await json(overflow, 422)).toMatchObject({ code: 'statement_applicability_too_large' });
}, 120_000);

test('projection participants are refused with an applicability instruction', async () => {
  const response = await owner.send('POST', '/v1/relations/changes', { profile: 'relation-change-v1', expectedHead: null,
    definition: relation.revision, participations: [
      { role: 'subject', participant: { kind: 'resource', ref: projection } },
      { role: 'counterpart', participant: { kind: 'resource', ref: canon } },
    ], actingSubject: owner.actor });
  expect(await json(response, 422)).toMatchObject({ code: 'projection_participant_refused', title: expect.stringContaining('applicability') });
  const secret = (await json<{ component: string }>(await owner.send('POST', '/v1/semantic/changes',
    { profile: 'semantic-change-v1', expectedHead: null, actingSubject: owner.actor,
      state: { component: 'resource', types: [`${RV}NarrativeContinuity`], properties: [
        { predicate: 'https://schema.org/name', value: { kind: 'language-string', lexical: 'Private continuity', language: 'en' } },
      ] } }), 201)).component;
  await owner.grant(`semantic:read:${secret}`, 'semantic.read');
  const hidden = await project([secret]);
  const outsider = await stack.member('hidden-projection-reader');
  await outsider.grant('relation:create:root', 'relation.change');
  const unavailable = await outsider.send('POST', '/v1/relations/changes', { profile: 'relation-change-v1', expectedHead: null,
    definition: relation.revision, participations: [
      { role: 'subject', participant: { kind: 'resource', ref: hidden } },
      { role: 'counterpart', participant: { kind: 'resource', ref: canon } },
    ], actingSubject: outsider.actor });
  expect(await json(unavailable, 422)).toMatchObject({ code: 'unavailable_reference' });
  expect((await outsider.read(`/v1/resources/${short(subject)}/statements?frame=${encodeURIComponent(secret)}`)).status).toBe(404);
  await outsider.grant(`statement:speak:${outsider.actor}`, 'statement.record');
  const hiddenStatement = await outsider.send('POST', '/v1/statements', { profile: 'statement-v1',
    speaker: { kind: 'personal' }, subject: hidden, predicate: 'https://example.org/fact',
    relationDefinition: 'https://example.org/meaning', value: { kind: 'no-value' }, applicability: [],
    interpretation: { kind: 'selected' }, evidence: [], actingSubject: outsider.actor });
  expect(await json(hiddenStatement, 409)).toMatchObject({ code: 'target_unavailable' });
  const normalized = await statement([], hidden);
  expect(await json(await owner.read(`/v1/statements/${short(normalized.statement)}`)))
    .toMatchObject({ subject, applicability: [secret] });
}, 120_000);

test('frame filters preserve OR within a dimension, AND across dimensions, specificity and continuation bindings', async () => {
  const scopes = [[], [canon, legends], [legends], [canon, chapter], [canon, later]];
  const saved = [];
  const occurrences = [];
  for (const applicability of scopes) {
    const record = await statement(applicability); await accept(record); saved.push(record.statement);
    occurrences.push(await occurrence(applicability));
  }
  const filtered = await readStatements([canon, chapter]);
  expect(ids(filtered)).toContain(saved[0]!); expect(ids(filtered)).toContain(saved[1]!);
  expect(ids(filtered)).toContain(saved[3]!); expect(ids(filtered)).not.toContain(saved[2]!);
  expect(ids(filtered)).not.toContain(saved[4]!);
  const match = filtered.groups.flatMap(group => group.items).filter(item => item.kind === 'statement').map(item => item.frameMatch!.score);
  expect(match).toEqual([...match].sort((a,b) => b-a));
  const relations = await json<RelationPage>(await owner.read(`/v1/resources/${short(subject)}/relations?${frameQuery([canon, chapter]).slice(1)}`));
  expect(Value.Check(resourceRelationPage, relations)).toBe(true);
  expect(relations.items.filter(item => occurrences.includes(item.relation)).map(item => item.relation))
    .toEqual([occurrences[3]!, occurrences[1]!, occurrences[0]!]);
  const first = await json<StatementPage>(await owner.read(`/v1/resources/${short(subject)}/statements?limit=1${frameQuery([canon, chapter])}`));
  expect(first.nextCursor).toBeString();
  const next = await json<StatementPage>(await owner.read(`/v1/resources/${short(subject)}/statements?limit=1${frameQuery([canon, chapter])}&cursor=${first.nextCursor}`));
  expect(ids(next)).not.toEqual(ids(first));
  expect((await owner.read(`/v1/resources/${short(subject)}/statements?limit=1${frameQuery([legends])}&cursor=${first.nextCursor}`)).status).toBe(400);
  expect((await owner.read(`/v1/resources/${short(subject)}/relations?frame=${encodeURIComponent(subject)}`)).status).toBe(400);
  const firstRelations = await json<RelationPage>(await owner.read(`/v1/resources/${short(subject)}/relations?limit=1${frameQuery([canon, chapter])}`));
  const remainingRelations = await json<RelationPage>(await owner.read(`/v1/resources/${short(subject)}/relations?limit=1${frameQuery([canon, chapter])}&after=${firstRelations.next}`));
  expect(remainingRelations.items[0]!.relation).not.toBe(firstRelations.items[0]!.relation);
  expect((await owner.read(`/v1/resources/${short(subject)}/relations?limit=1${frameQuery([legends])}&after=${firstRelations.next}`)).status).toBe(400);
  expect((await readStatements()).groups.flatMap(group => group.items).every(item => item.frameMatch === undefined)).toBe(true);
}, 120_000);

test('Work and chapter frames inherit disclosed in-continuity membership with a constant preparation read', async () => {
  const definition = await membershipDefinition();
  const record = await statement([canon]); await accept(record);
  const scopedRelation = await occurrence([canon]);
  expect(ids(await readStatements([work.work]))).not.toContain(record.statement);
  const joined = await joinContinuity(definition, work.work, canon);
  const query = stack.fuseki.query.bind(stack.fuseki);
  let membershipQueries = 0;
  stack.fuseki.query = async (sparql, maximum) => {
    if (sparql.includes('SELECT DISTINCT ?work ?continuity ?occurrence')) membershipQueries++;
    return query(sparql, maximum);
  };
  try {
    expect(ids(await readStatements([work.work]))).toContain(record.statement);
    expect(membershipQueries).toBe(1);
    expect(ids(await readStatements([chapter]))).toContain(record.statement);
    expect(membershipQueries).toBe(2);
  } finally { stack.fuseki.query = query; }
  // A release lies in its Work, so it inherits the Work's continuity as a position does.
  expect(ids(await readStatements([edition.release]))).toContain(record.statement);
  const page = await json<RelationPage>(await owner.read(`/v1/resources/${short(subject)}/relations?frame=${encodeURIComponent(work.work)}`));
  expect(page.items.find(item => item.relation === scopedRelation)?.frameMatch)
    .toEqual({ dimensions: 1, exact: 0, score: 16 });
  await json(await owner.send('POST', '/v1/relations/changes', { profile: 'relation-change-v1', expectedHead: null,
    definition: definition.revision, participations: [
      { role: 'work', participant: { kind: 'resource', ref: work.work } },
      { role: 'continuity', participant: { kind: 'resource', ref: legends } },
    ], actingSubject: owner.actor }), 201);
  const legendsRecord = await statement([legends]); await accept(legendsRecord);
  expect(ids(await readStatements([work.work]))).toContain(legendsRecord.statement);
  expect(ids(await readStatements([work.work, canon]))).not.toContain(legendsRecord.statement);
  const explicit = await json<RelationPage>(await owner.read(`/v1/resources/${short(subject)}/relations?${frameQuery([work.work, canon]).slice(1)}`));
  expect(explicit.items.find(item => item.relation === scopedRelation)?.frameMatch)
    .toEqual({ dimensions: 1, exact: 1, score: 17 });
  const rows = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${iri(joined.occurrence)} rv:occurrenceHead ?head } }`)).results!.bindings;
  await json(await owner.send('POST', '/v1/relations/changes', { profile: 'relation-change-v1', occurrence: joined.occurrence, expectedHead: rows[0]!.head!.value,
    definition: definition.revision, lifecycle: 'retired', participations: [
      { role: 'work', participant: { kind: 'resource', ref: work.work } },
      { role: 'continuity', participant: { kind: 'resource', ref: canon } },
    ], actingSubject: owner.actor }));
  expect(ids(await readStatements([work.work]))).not.toContain(record.statement);
}, 120_000);

test('projection pages retain the subject header, frame summaries and own judgments, and apply the subject reading position', async () => {
  const scopedSubject = await semantic('Spoiler character', `${RV}Character`);
  const scopedProjection = (await json<{ projection: { id: string } }>(await owner.send('POST', '/v1/projections',
    { subject: scopedSubject, frames: [canon, chapter], actingSubject: owner.actor }), 201)).projection.id;
  const record = await statement([canon, chapter], scopedSubject); await accept(record);
  const scopedRelation = await occurrence([canon, chapter], scopedSubject);
  const store = new ReadingPositionStore(stack.contentPool);
  const client = await stack.contentPool.connect();
  try {
    await client.query('BEGIN');
    await store.write(client, { record: record.statement, recordKind: 'statement', continuityWork: work.work,
      occurrence: later, receipt: randomUUID() }, null);
    await store.write(client, { record: scopedRelation, recordKind: 'relation', continuityWork: work.work,
      occurrence: later, receipt: randomUUID() }, null);
    await client.query('COMMIT');
  } finally { client.release(); }
  const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access, media: stack.media,
    mediaAccess: stack.mediaAccess, readingPositions: store, account: { verify: async () => owner.principal } });
  const page = async (position: string) => json<Static<typeof entityPage>>(await app.handle(new Request(
    `http://main.local/v1/resources/${short(scopedProjection)}/page?actingSubject=${encodeURIComponent(owner.actor)}&position=${encodeURIComponent(position)}`,
    { headers: { authorization: `Bearer ${owner.token}` } })));
  const early = await page(chapter), all = await page('all');
  expect(Value.Check(entityPage, early)).toBe(true);
  expect(early.projection).toMatchObject({ subject: { reference: scopedSubject } });
  // Judgments are not inlined: the page links the projection's own ratings, reviews and discussion reads.
  expect(Object.keys(early.projection!).sort()).toEqual(['frames', 'relations', 'statements', 'subject']);
  for (const id of ['ratings', 'reviews', 'discussion']) {
    expect(early.sections.find(section => section.id === id)!.href).toBe(`/v1/resources/${short(scopedProjection)}/${id}`);
  }
  expect(early.projection!.frames.map(frame => frame.reference).sort()).toEqual([canon, chapter].sort());
  expect(ids(early.projection!.statements)).not.toContain(record.statement);
  expect(ids(all.projection!.statements)).toContain(record.statement);
  expect(early.projection!.relations.items.map(item => item.relation)).not.toContain(scopedRelation);
  expect(all.projection!.relations.items.map(item => item.relation)).toContain(scopedRelation);
  expect(early.sections.map(section => section.id)).toEqual(['statements','relations','ratings','reviews','discussion']);
  expect(early.sections[0]!.href).toContain(short(scopedSubject)); expect(early.sections[0]!.href).toContain('frame=');
  expect(new URL(early.sections[0]!.href, 'http://main.local').searchParams.get('position')).toBe(chapter);
  const subjectRead = await json<StatementPage>(await app.handle(new Request(
    `http://main.local/v1/resources/${short(scopedSubject)}/statements?actingSubject=${encodeURIComponent(owner.actor)}&position=all${frameQuery([canon, chapter])}`,
    { headers: { authorization: `Bearer ${owner.token}` } })));
  expect(ids(subjectRead)).toContain(record.statement);
}, 120_000);

test('canonicity is a seeded Concept judgment on the subject, scoped to continuity and accepted by Context', async () => {
  const state = await json<{ state: { kind: string; notation: string } }>(await owner.read(
    `/v1/semantic/resources/${short(vocabulary.definition.component)}`));
  expect(state.state).toMatchObject({ kind: 'property', notation: 'canonicity' });
  const record = await statement([canon], subject, randomUUID(), { kind: 'resource', iri: vocabulary.concepts.canon });
  expect(ids(await readStatements([canon]))).not.toContain(record.statement);
  await accept(record);
  const page = await readStatements([canon]);
  expect(page.groups.flatMap(group => group.items).find(item => item.kind === 'statement' && item.statement === record.statement))
    .toMatchObject({ speaker: owner.actor, predicate: CANONICITY_PROPERTY, value: { kind: 'resource', iri: vocabulary.concepts.canon },
      qualifiers: { applicability: [canon] } });
  expect(ids(await readStatements([legends]))).not.toContain(record.statement);
  for (const concept of Object.values(vocabulary.concepts)) expect((await owner.read(`/v1/resources/${short(concept)}`)).status).toBe(200);
  const members = (await stack.fuseki.query(`SELECT ?concept WHERE { GRAPH ${iri(GRAPHS.current)} {
    ?concept <http://www.w3.org/2004/02/skos/core#inScheme> ${iri(vocabulary.scheme)} } }`)).results!.bindings;
  expect(members.map(row => row.concept!.value).sort()).toEqual(Object.values(vocabulary.concepts).sort());
}, 120_000);

const post = (frames: string[]) => owner.send('POST', '/v1/projections', { subject, frames, actingSubject: owner.actor });

test('one "X in F" has one projection: a Work its position implies is dropped, and frames that disagree are refused', async () => {
  const dropped = await json<{ projection: { id: string; frames: string[] } }>(await post([work.work, inVolume]), 201);
  expect(dropped.projection.frames).toEqual([inVolume]);
  expect((await json<typeof dropped>(await post([inVolume]), 200)).projection.id).toBe(dropped.projection.id);
  expect((await json<typeof dropped>(await post([inVolume, work.work]), 200)).projection.id).toBe(dropped.projection.id);
  // A release or realization implies its Work as well; a position and a release lie in different slots and both stay.
  const release = await json<typeof dropped>(await post([work.work, edition.release]), 201);
  expect(release.projection.frames).toEqual([edition.release]);
  expect((await json<typeof dropped>(await post([edition.release]), 200)).projection.id).toBe(release.projection.id);
  const both = await json<typeof dropped>(await post([inVolume, edition.release]), 201);
  expect(both.projection.frames).toEqual([inVolume, edition.release].sort());
  expect(both.projection.id).not.toBe(release.projection.id);
  // Reads normalize the same way as the write: the Work adds nothing to what its position says.
  expect(ids(await readStatements([work.work, inVolume]))).toEqual(ids(await readStatements([inVolume])));
  const refused = async (frames: string[], code: string) => expect(await json(await post(frames), 422)).toMatchObject({ code });
  await refused([work.work, foreign.chapter], 'projection_frame_work_mismatch');
  await refused([edition.release, foreign.chapter], 'projection_frame_work_mismatch');
  await refused([foreign.release, chapter], 'projection_frame_work_mismatch');
  await refused([work.work, foreign.release], 'projection_frame_work_mismatch');
  await refused([chapter, later], 'projection_frame_slot_repeated');
  await refused([foreign.chapter, chapter], 'projection_frame_slot_repeated');
  await refused([edition.release, edition.realization], 'projection_frame_slot_repeated');
  expect((await owner.read(`/v1/resources/${short(subject)}/statements?frame=${encodeURIComponent(work.work)}&frame=${encodeURIComponent(foreign.chapter)}`)).status).toBe(400);
  expect((await owner.read(`/v1/resources/${short(subject)}/statements?frame=${encodeURIComponent(chapter)}&frame=${encodeURIComponent(later)}`)).status).toBe(400);
}, 120_000);

test('a position is covered by the Structure group above it and by its Work; a release and a realization by their Work', async () => {
  const saved: Record<string, string> = {};
  for (const [name, applicability] of Object.entries({ volume: [volumeOne], otherVolume: [volumeTwo], work: [work.work],
    release: [edition.release], chapter: [chapter], everywhere: [] as string[] })) {
    const record = await statement(applicability); await accept(record); saved[name] = record.statement;
  }
  const on = async (...frames: string[]) => ids(await readStatements(frames));
  const inside = await on(inVolume);
  expect(inside).toEqual(expect.arrayContaining([saved.volume!, saved.work!, saved.everywhere!]));
  for (const missing of ['otherVolume', 'chapter', 'release']) expect(inside, missing).not.toContain(saved[missing]!);
  const other = await on(inOtherVolume);
  expect(other).toEqual(expect.arrayContaining([saved.otherVolume!, saved.work!, saved.everywhere!]));
  expect(other).not.toContain(saved.volume!);
  // A chapter directly under the Book has no group above it; a group is itself a position.
  const top = await on(chapter);
  expect(top).toEqual(expect.arrayContaining([saved.chapter!, saved.work!, saved.everywhere!]));
  for (const missing of ['volume', 'otherVolume']) expect(top, missing).not.toContain(saved[missing]!);
  expect(await on(volumeOne)).toEqual(expect.arrayContaining([saved.volume!, saved.work!]));
  expect(await on(volumeOne)).not.toContain(saved.otherVolume!);
  // A release and a realization lie in their Work and nothing finer; a Work lies in neither.
  const edition_ = await on(edition.release);
  expect(edition_).toEqual(expect.arrayContaining([saved.release!, saved.work!, saved.everywhere!]));
  for (const missing of ['volume', 'chapter']) expect(edition_, missing).not.toContain(saved[missing]!);
  const realized = await on(edition.realization);
  expect(realized).toEqual(expect.arrayContaining([saved.work!, saved.everywhere!]));
  expect(realized).not.toContain(saved.release!);
  const whole = await on(work.work);
  expect(whole).toEqual(expect.arrayContaining([saved.work!, saved.everywhere!]));
  for (const missing of ['volume', 'otherVolume', 'chapter', 'release']) expect(whole, missing).not.toContain(saved[missing]!);
  // Inherited coverage ranks below an exact coordinate, and a Statement for another Work's group is never shown.
  const ranked = (await readStatements([inVolume])).groups.flatMap(group => group.items)
    .flatMap(item => item.kind === 'statement' ? [[item.statement, item.frameMatch!.score] as const] : []);
  expect(Object.fromEntries(ranked)).toMatchObject({ [saved.volume!]: 16, [saved.work!]: 16, [saved.everywhere!]: 0 });
  // Relations use the same coverage.
  const grouped = await occurrence([volumeOne]);
  const relationsOn = async (frame: string) => (await json<RelationPage>(await owner.read(
    `/v1/resources/${short(subject)}/relations?frame=${encodeURIComponent(frame)}`))).items.map(item => item.relation);
  expect(await relationsOn(inVolume)).toContain(grouped);
  expect(await relationsOn(inOtherVolume)).not.toContain(grouped);
  expect(await relationsOn(chapter)).not.toContain(grouped);
  // The ancestor walk takes one query per level of the Structure above the position and nothing for other frames.
  const query = stack.fuseki.query.bind(stack.fuseki);
  let ancestorQueries = 0;
  stack.fuseki.query = async (sparql, maximum) => {
    if (sparql.includes('SELECT ?parent ?inner')) ancestorQueries++;
    return query(sparql, maximum);
  };
  try {
    await on(work.work, canon); expect(ancestorQueries).toBe(0);
    await on(chapter); expect(ancestorQueries).toBe(1);
    await on(inVolume); expect(ancestorQueries).toBe(3);
  } finally { stack.fuseki.query = query; }
}, 180_000);

test('a Statement names only existing coordinates, and a caller cannot move a projection Statement out of its frame', async () => {
  const write = (on: string, applicability: string[], key = randomUUID()) => owner.send('POST', '/v1/statements',
    { profile: 'statement-v1', speaker: { kind: 'personal' }, subject: on, predicate: 'https://example.org/fact',
      relationDefinition: 'https://example.org/meaning', value: { kind: 'literal', lexical: key,
        datatype: 'http://www.w3.org/2001/XMLSchema#string', language: null },
      applicability, interpretation: { kind: 'selected' }, evidence: [], actingSubject: owner.actor }, key);
  const refused = async (on: string, applicability: string[], code: string) =>
    expect(await json(await write(on, applicability), 422)).toMatchObject({ code });
  // Unknown IRIs (an Agent is not a graph Resource), projections and Resources without a frame dimension are not applicability.
  await refused(subject, ['https://example.org/qualifier'], 'statement_applicability_unknown');
  await refused(subject, [id()], 'statement_applicability_unknown');
  await refused(subject, [canon, projection], 'statement_applicability_projection');
  await refused(subject, [owner.actor], 'statement_applicability_unknown');
  await refused(subject, [subject], 'statement_applicability_not_coordinate');
  // Coordinates of any slot are fine on a plain subject, several in one slot as OR alternatives.
  await json(await write(subject, [canon, legends, chapter, edition.release]), 201);
  // "X in chapter 1" with applicability chapter 2 would be stored as chapter 1 or 2, and shown for "X in chapter 2".
  const inChapter = await project([chapter]);
  await refused(inChapter, [later], 'statement_applicability_slot_occupied');
  await refused(inChapter, [work.work], 'statement_applicability_slot_occupied');
  await refused(inChapter, [chapter, later], 'statement_applicability_slot_occupied');
  const stored = await json<{ statement: string }>(await write(inChapter, [chapter, canon]), 201);
  expect(await json(await owner.read(`/v1/statements/${short(stored.statement)}`))).toMatchObject({ subject,
    applicability: [chapter, canon].sort() });
  await accept(stored);
  expect(ids(await readStatements([later]))).not.toContain(stored.statement);
  expect(ids(await readStatements([canon, chapter]))).toContain(stored.statement);
}, 120_000);

test('memberships a reader cannot see never fail a frame read, whatever their number', async () => {
  const crowded = await publish(`A crowded Book ${namespace}`);
  const hiddenContinuity = (await json<{ component: string }>(await owner.send('POST', '/v1/semantic/changes',
    { profile: 'semantic-change-v1', expectedHead: null, actingSubject: owner.actor,
      state: { component: 'resource', types: [`${RV}NarrativeContinuity`], properties: [
        { predicate: 'https://schema.org/name', value: { kind: 'language-string', lexical: 'Private continuity', language: 'en' } },
      ] } }), 201)).component;
  await owner.grant(`semantic:read:${hiddenContinuity}`, 'semantic.read');
  const definition = await membershipDefinition();
  // More in-continuity memberships than a frame read may rely on, none of them readable by an outsider.
  for (let index = 0; index < 66; index++) await joinContinuity(definition, crowded.work, hiddenContinuity);
  const visible = await joinContinuity(definition, crowded.work, canon);
  await owner.grant(`semantic:read:${visible.occurrence}`, 'semantic.read');
  const record = await statement([canon]); await accept(record);
  const outsider = await stack.member('crowded-reader');
  const read = await outsider.read(`/v1/resources/${short(subject)}/statements?limit=20&frame=${encodeURIComponent(crowded.work)}`);
  expect(read.status).toBe(200);
  expect(ids(await json<StatementPage>(read))).toContain(record.statement);
}, 240_000);
