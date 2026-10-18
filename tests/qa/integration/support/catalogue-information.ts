import { expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { SemanticValue } from '../../../../services/main/src/modules/semantic/value.ts';
import {
  collectionCases, fieldStates, informationMatrix, orderCases, supportingRecords,
  type CollectionKey, type FieldState, type OrderKey, type SupportingKey,
} from '../../fixtures/catalogue-information-matrix.ts';
import {
  restorePersonaRealms, type PersonaName, type PersonaSession, type PersonaSessions,
  type RetainedPersonaRealm,
} from '../../support/personas.ts';

// Proposed additions are local test types. No production header, schema or frame is changed.
export type FactValue =
  | { kind: 'literal'; lexical: string; datatype: string; language: string | null }
  | { kind: 'resource'; iri: string }
  | { kind: 'some-value' | 'no-value' };
export interface Support {
  id: string; sourceWork: string; representationSha256: string; locator: { pointer: string };
  rightsBasis: string; quoteWithheld: boolean;
}
export interface FrozenSupport extends Support {
  file: string;
}
interface Qualifiers {
  applicability: string[]; interpretationDefinitions: string[]; qualification?: Record<string, unknown>;
}
interface Acceptance { context: string; decision: string; source: string }
export interface FactExpectation {
  key: string; predicate: string; state: FieldState; order: number;
  values: ({ source: FrozenSupport; qualifiers: Qualifiers } & (
    | { kind: 'statement'; value: FactValue; acceptance: Acceptance | null }
    | { kind: 'component-property'; value: SemanticValue }
  ))[];
  sources: FrozenSupport[];
}
export interface ResourceFixture {
  resource: string; revision: string; registryType: string;
  work?: string;
  source: { provider: string; namespace: string; externalId: string; key: string; url: string;
    snapshot: FrozenSupport; identityPointer: string; namePointer: string };
  name: string;
  fields: FactExpectation[];
}
export interface EdgeExpectation {
  relation: string; revision: string; definition: string; viewingRole: string;
  counterpart: string; counterpartBase: string; counterpartRole: string;
  applicability: string[]; source: FrozenSupport;
}
export interface PartExpectation {
  occurrence: string; parent: string; role: string; target: { resource: string; base: string; types: string[] } | null;
  sourceOrder: { position: number; label: string | null; source: string };
  source: FrozenSupport;
  labelSource: FrozenSupport | null;
}
export interface OrderedFixture {
  resource: string; structure: string; revision: string; parent?: string;
  items: PartExpectation[];
}
export interface CollectionFixture {
  resource: string; member: string; revision: string; name: string;
  purpose: { kind: string; statement: string; revision: string; sources: string[] } | null;
  occurrences: { occurrence: string; target: string }[];
}
interface FixtureCommand {
  method: 'POST' | 'PUT'; path: string; body: Record<string, unknown>; status: number; key: string;
}
export interface InformationCorpus {
  profile: 'catalogue-information-corpus-v1';
  productBaseline: string;
  preparation: { elapsedMs: number; stopped: true; backup: string; backupSha256: string;
    owners: string[]; receipts: { file: string; sha256: string }[] };
  realm: RetainedPersonaRealm;
  records: Record<SupportingKey, ResourceFixture>;
  inverse: Record<'character' | 'person' | 'organization' | 'concept' | 'artist' | 'recording' | 'composition' | 'label', EdgeExpectation[]>;
  orders: Record<OrderKey, OrderedFixture>;
  collections: Record<CollectionKey, CollectionFixture>;
  controls: {
    states: Record<FieldState, { resource: string; field: FactExpectation }>;
    values: Record<'zero' | 'empty-literal' | 'some-value' | 'no-value' | 'null-language' | 'non-english', {
      resource: string; field: FactExpectation;
    }>;
    empty: string; missing: string; nullRecipe: string;
    hidden: { resources: string[]; evidence: string[]; paths: string[]; tokens: string[] };
    // Fixed public commands, prepared against this one restored corpus. The owner
    // must supply genuine stale-write/idempotency fields, never direct graph writes.
    privateMutation: FixtureCommand;
    publicMutation: FixtureCommand;
    recovery: Record<'recipe' | 'chapter', { resource: string; href: string; queryReference: string;
      identity: Record<string, string> }>;
  };
}

export interface EntityPage {
  profile: string;
  target: { resource: string; revision: string; base: string; types: string[] };
  registry: { type: string; default: boolean; labels: { en: { one: string } } };
  summary: { reference: string; status: string; name?: { value: string } };
  sections: { id: string; href: string; actions: string[] }[];
}
export interface FactItem {
  kind: string; statement?: string; revision: string; predicate: string; value: FactValue | SemanticValue;
  qualifiers: Qualifiers;
  sources: string[]; evidence?: Support[];
  acceptance?: Acceptance | null;
}
export interface FactGroup {
  predicate: string; display: { label: { value: string; language: string }; order: number };
  coverage: { state: FieldState; sources: string[]; retry: { href: string; afterMs: number } | null };
  items: FactItem[];
}
interface StatementPage {
  profile: string; resource: string; groups: FactGroup[]; nextCursor: string | null;
  count: { value: number; kind: string; total: null };
}
export interface RelationEntry {
  relation: string; revision: string | null; kind: string;
  citations?: Support[];
  rendering: null | {
    meaning: { definition: string }; viewingRole: string;
    bindings: { role: string; participant: unknown }[];
    projections: { fromRole: string; toRole: string; labels: { heading: string | null } | null }[];
  };
  // Exact qualification survives both directions; no context is inferred from a name.
  applicability: string[];
  counterparts: { reference: string; status: string; base?: string }[];
  collectionPurpose?: CollectionFixture['purpose'];
}
export interface PartsPage {
  resource: string; structure: string; revision: string;
  parts: (Omit<PartExpectation, 'source' | 'labelSource'> & { segmentKey: string; orderKey: string })[];
  next: string | null;
}

function localFile(path: string): string {
  const file = realpathSync(resolve(path));
  const local = relative(realpathSync(process.cwd()), file);
  if (!local || local.startsWith('..') || isAbsolute(local)) throw new Error('Corpus file must stay in this worktree');
  return file;
}
function checkedBytes(path: string, digest: string): Buffer {
  const bytes = readFileSync(localFile(path));
  if (!/^[a-f0-9]{64}$/.test(digest) || createHash('sha256').update(bytes).digest('hex') !== digest)
    throw new Error(`Frozen corpus digest mismatch: ${path}`);
  return bytes;
}
function sourceAtom(source: FrozenSupport): unknown {
  let value: unknown = JSON.parse(checkedBytes(source.file, source.representationSha256).toString());
  if (!source.locator.pointer.startsWith('/')) throw new Error('A field needs an exact non-root JSON pointer');
  for (const token of source.locator.pointer.slice(1).split('/')) {
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key))
      throw new Error(`Frozen source pointer is absent: ${source.locator.pointer}`);
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function checkFieldPremise(field: FactExpectation): void {
  expect(fieldStates).toContain(field.state);
  for (const source of field.sources) sourceAtom(source);
  for (const { kind, value, source } of field.values) {
    expect(['statement', 'component-property']).toContain(kind);
    if (kind === 'statement') expect(['literal', 'resource', 'some-value', 'no-value']).toContain(value.kind);
    else expect(['integer', 'decimal', 'rational', 'boolean', 'string', 'language-string', 'temporal',
      'quantity', 'resource', 'external', 'unknown', 'no-value']).toContain(value.kind);
    const atom = sourceAtom(source);
    if ('lexical' in value) {
      expect(['string', 'number', 'boolean']).toContain(typeof atom);
      expect(value.lexical).toBe(String(atom).normalize('NFC'));
    }
    if (value.kind === 'resource') expect(typeof atom).toBe('string');
    if (value.kind === 'some-value' || value.kind === 'unknown') expect(atom).toBe('somevalue');
    if (value.kind === 'no-value') expect(atom).toBe('novalue');
    expect(field.sources.map(support => support.id)).toContain(source.id);
  }
  if (field.state !== 'adopted') expect(field.values).toEqual([]);
}

/** Read before starting a stack. Missing preparation is a setup blocker, never a
 * test.failing success or an invented product failure. No network acquisition here. */
export function loadInformationCorpus(): InformationCorpus {
  const path = Bun.env.REZICS_INFORMATION_CORPUS ?? informationMatrix.sourceFixture.path;
  let corpus: InformationCorpus;
  try { corpus = JSON.parse(readFileSync(localFile(path), 'utf8')) as InformationCorpus; }
  catch (cause) {
    throw new Error(`Missing retained catalogue-information corpus: ${path}. ${informationMatrix.sourceFixture.requirement}`, { cause });
  }
  expect(corpus.profile).toBe('catalogue-information-corpus-v1');
  expect(corpus.productBaseline).toBe(informationMatrix.baselineProduct);
  expect(corpus.preparation.stopped).toBe(true);
  expect(corpus.preparation.elapsedMs).toBeGreaterThan(0);
  expect(corpus.preparation.elapsedMs).toBeLessThanOrEqual(informationMatrix.preparationLimitMs);
  expect(corpus.preparation.owners.toSorted()).toEqual(['access', 'account', 'content', 'graph', 'objects']);
  checkedBytes(corpus.preparation.backup, corpus.preparation.backupSha256);
  expect(corpus.preparation.receipts.length).toBeGreaterThan(0);
  for (const receipt of corpus.preparation.receipts) checkedBytes(receipt.file, receipt.sha256);
  for (const [key, specification] of Object.entries(supportingRecords)) {
    const record = corpus.records[key as SupportingKey];
    expect(record.source.provider, key).toBe(specification.provider);
    expect(record.registryType, key).toBe(specification.type);
    expect(record.source.externalId.length, key).toBeGreaterThan(0);
    expect(record.source.key.length, key).toBeGreaterThan(0);
    expect(record.name.length, key).toBeGreaterThan(0);
    expect(String(sourceAtom({ ...record.source.snapshot, locator: { pointer: record.source.identityPointer } })))
      .toBe(record.source.externalId);
    expect(sourceAtom({ ...record.source.snapshot, locator: { pointer: record.source.namePointer } }))
      .toBe(record.name);
    expect(record.fields.map(field => field.key).toSorted(), key).toEqual([...specification.fields].toSorted());
    expect(record.fields.some(field => field.state === 'adopted' && field.values.length > 0), key).toBe(true);
    expect(record.fields.some(field => !['name', 'identifier'].includes(field.key)
      && field.state === 'adopted' && field.values.length > 0), `${key} must exceed an identity shell`).toBe(true);
    for (const field of record.fields) checkFieldPremise(field);
  }
  expect(corpus.records.nativeRelease.work).toMatch(/^https:\/\/rezics\.com\/id\//);
  expect(Object.values(corpus.records).some(record => record.fields.some(field =>
    field.values.some(value => value.qualifiers.applicability.length > 0)))).toBe(true);
  for (const key of ['character', 'person', 'organization', 'concept'] as const) {
    for (const field of ['aliases', 'description'])
      expect(corpus.records[key].fields.find(item => item.key === field)?.state).toBe('adopted');
  }
  for (const [key, edges] of Object.entries(corpus.inverse)) {
    expect(edges.length, `${key} needs real inverse paths and a continuation`).toBeGreaterThanOrEqual(2);
    for (const edge of edges) sourceAtom(edge.source);
  }
  expect(Object.keys(corpus.inverse).toSorted()).toEqual(
    ['character', 'person', 'organization', 'concept', 'artist', 'recording', 'composition', 'label'].toSorted());
  for (const state of fieldStates) {
    expect(corpus.controls.states[state].field.state).toBe(state);
    checkFieldPremise(corpus.controls.states[state].field);
  }
  for (const value of Object.values(corpus.controls.values)) checkFieldPremise(value.field);
  expect(Object.keys(corpus.controls.values).toSorted()).toEqual(
    ['zero', 'empty-literal', 'some-value', 'no-value', 'null-language', 'non-english'].toSorted());
  expect(corpus.controls.values.zero.field.values[0]?.value).toMatchObject({ kind: 'literal', lexical: '0' });
  expect(corpus.controls.values['empty-literal'].field.values[0]?.value).toMatchObject({ kind: 'literal', lexical: '' });
  expect(corpus.controls.values['some-value'].field.values[0]?.value).toEqual({ kind: 'some-value' });
  expect(corpus.controls.values['no-value'].field.values[0]?.value).toEqual({ kind: 'no-value' });
  expect(corpus.controls.values['null-language'].field.values[0]?.value).toMatchObject({ kind: 'literal', language: null });
  const nonEnglish = corpus.controls.values['non-english'].field.values[0]?.value;
  expect(nonEnglish?.kind).toBe('literal');
  if (nonEnglish?.kind === 'literal') {
    expect(nonEnglish.language).not.toBeNull();
    expect(nonEnglish.language).not.toBe('en');
  }
  for (const key of orderCases) {
    const order = corpus.orders[key];
    expect(order.items.length, key).toBeGreaterThanOrEqual(3);
    expect(new Set(order.items.map(item => item.occurrence)).size).toBe(order.items.length);
    for (const item of order.items) {
      expect(String(sourceAtom(item.source))).toBe(String(item.sourceOrder.position));
      expect(item.sourceOrder.source).toBe(item.source.id);
      if (item.sourceOrder.label !== null) {
        expect(item.labelSource).not.toBeNull();
        expect(String(sourceAtom(item.labelSource!))).toBe(item.sourceOrder.label);
      }
    }
  }
  // A real release has two distinct track placements of one recording, plus
  // another recording. This prevents substituting unique recordings for tracks.
  const tracks = corpus.orders.tracks.items.flatMap(item => item.target ? [item.target.resource] : []);
  expect(new Set(tracks).size).toBeLessThan(tracks.length);
  expect(new Set(tracks).size).toBeGreaterThanOrEqual(2);
  expect(corpus.orders.tracks.parent).toBeTruthy();
  expect(corpus.orders.tracks.items.every(track => track.parent === corpus.orders.tracks.parent)).toBe(true);
  expect(corpus.orders.tracks.items.every(track => track.target?.base === 'work'
    && track.target.resource !== corpus.records.composition.resource
    && track.target.types.includes('https://schema.org/MusicRecording'))).toBe(true);
  expect(corpus.orders.media.items.some(medium => medium.occurrence === corpus.orders.tracks.parent)).toBe(true);
  expect(corpus.orders.media.items.some(medium => medium.occurrence !== corpus.orders.tracks.parent)).toBe(true);
  expect(corpus.orders.episodes.items.every(episode => episode.target?.types.includes('https://schema.org/TVEpisode'))).toBe(true);
  for (const key of Object.keys(collectionCases) as CollectionKey[]) {
    const collection = corpus.collections[key];
    expect(collection.purpose?.kind ?? null, key).toBe(collectionCases[key].kind);
    expect(collection.occurrences.length, key).toBeGreaterThanOrEqual(3);
    expect(new Set(collection.occurrences.map(item => item.occurrence)).size).toBe(collection.occurrences.length);
  }
  expect(corpus.collections.bookList.member).toBe(corpus.records.book.resource);
  expect(corpus.collections.recipes.member).toBe(corpus.records.recipe.resource);
  expect(corpus.collections.ordinary.name).toContain('Series');
  for (const kind of ['recipe', 'chapter'] as const) {
    const section = corpus.controls.recovery[kind];
    expect(section.resource).toBe(corpus.records[kind === 'recipe' ? 'recipe' : 'book'].resource);
    expect(section.queryReference.length).toBeGreaterThan(0);
    expect(Object.keys(section.identity).length).toBeGreaterThan(0);
  }
  for (const values of Object.values(corpus.controls.hidden)) {
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) expect(value.length).toBeGreaterThan(0);
  }
  return corpus;
}

export async function openInformationCorpus(corpus: InformationCorpus, graphEndpoint?: string): Promise<PersonaSessions> {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Use goalctl test on an isolated restored QA stack');
  const previous = Bun.env.FUSEKI_URL;
  if (graphEndpoint) Bun.env.FUSEKI_URL = graphEndpoint;
  try {
    const [sessions] = await restorePersonaRealms([corpus.realm]);
    if (!sessions) throw new Error('Retained corpus Realm did not restore');
    expect(sessions.owner.actingSubject).toBe(corpus.realm.identities.owner.actingSubject);
    return sessions;
  } finally { Bun.env.FUSEKI_URL = previous; }
}

export const resourcePath = (resource: string, suffix: string) => `/v1/resources/${resource.slice(-36)}/${suffix}`;
export type Read = (path: string, status?: number) => Promise<Response>;
export function publicRead(session: PersonaSession): Read {
  // Deliberately omit actingSubject: even an owning/operator identity consumes
  // the pinned public view. Management reads have their own profile and route.
  return (path) => session.main('GET', path, undefined, undefined,
    { headers: { 'accept-language': 'en' } });
}
export async function body<T>(read: Read, path: string, status = 200): Promise<T> {
  const response = await read(path, status);
  const raw = await response.text();
  expect(response.status, `${path}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
export function noHidden(value: unknown, corpus: InformationCorpus): void {
  const text = JSON.stringify(value);
  for (const hidden of Object.values(corpus.controls.hidden).flat()) expect(text).not.toContain(hidden);
}
export function assertIdentity(page: EntityPage, key: SupportingKey, corpus: InformationCorpus): void {
  const expected = corpus.records[key], specification = supportingRecords[key];
  expect(page.profile).toBe('entity-page-v1');
  expect(page.target).toMatchObject({ resource: expected.resource, revision: expected.revision, base: specification.base });
  expect(page.target.types).toContain(specification.type);
  expect(page.registry.type).toBe(expected.registryType);
  expect(page.registry.default).toBe(false);
  expect(page.registry.labels.en.one).not.toBe('Resource');
  expect(page.summary.reference).toBe(expected.resource);
  expect(page.sections.find(section => section.id === 'statements')?.href)
    .toBe(resourcePath(expected.resource, 'statements'));
  expect(page.sections.find(section => section.id === 'relations')?.href)
    .toBe(resourcePath(expected.resource, 'relations'));
  noHidden(page, corpus);
}

export async function factGroups(read: Read, resource: string, corpus: InformationCorpus): Promise<FactGroup[]> {
  const groups: FactGroup[] = [], cursors = new Set<string>();
  let after: string | null = null;
  do {
    const query = new URLSearchParams({ limit: '2', ...(after ? { after } : {}) });
    const page = await body<StatementPage>(read, `${resourcePath(resource, 'statements')}?${query}`);
    expect(page.profile).toBe('subject-statements-v1');
    expect(page.resource).toBe(resource);
    expect(page.count).toMatchObject({ kind: 'exact-page', total: null });
    expect(page.count.value).toBe(page.groups.reduce((count, group) => count + group.items.length, 0));
    noHidden(page, corpus);
    for (const group of page.groups) {
      const previous = groups.at(-1);
      if (previous?.predicate === group.predicate) {
        expect(group.display).toEqual(previous.display);
        expect(group.coverage).toEqual(previous.coverage);
        previous.items.push(...group.items);
      } else groups.push(group);
    }
    after = page.nextCursor;
    if (after) {
      expect(cursors.has(after), 'continuation must advance').toBe(false);
      cursors.add(after);
      expect(cursors.size, 'small corpus continuation must terminate').toBeLessThan(64);
    }
  } while (after);
  expect(new Set(groups.flatMap(group => group.items.map(item =>
    `${item.kind}:${item.statement ?? JSON.stringify([item.revision, item.predicate, item.value])}`))).size)
    .toBe(groups.reduce((count, group) => count + group.items.length, 0));
  return groups;
}

export function assertField(groups: FactGroup[], expected: FactExpectation): void {
  const group = groups.find(item => item.predicate === expected.predicate);
  expect(group, expected.key).toBeDefined();
  if (!group) throw new Error(`Missing ${expected.key}`);
  expect(group.display.label.language).toBe('en');
  expect(group.display.label.value.trim().length).toBeGreaterThan(0);
  expect(group.display.label.value).not.toMatch(/^(?:https?:|urn:)/);
  expect(group.display.order).toBe(expected.order);
  expect(group.coverage.state).toBe(expected.state);
  expect(group.coverage.sources.toSorted()).toEqual(expected.sources.map(source => source.id).toSorted());
  expect(group.items.map(item => item.value)).toEqual(expected.values.map(item => item.value));
  if (expected.state !== 'adopted') expect(group.items).toEqual([]);
  if (expected.state === 'acquisition-failed') {
    expect(group.coverage.retry?.href).toMatch(/^\/v1\/resources\//);
    expect(group.coverage.retry?.afterMs).toBeGreaterThanOrEqual(0);
    expect(group.coverage.retry?.afterMs).toBeLessThanOrEqual(30_000);
  } else expect(group.coverage.retry).toBeNull();
  for (const [index, item] of group.items.entries()) {
    const expectation = expected.values[index]!;
    const { kind, value, source, qualifiers } = expectation;
    expect(item.kind).toBe(kind);
    expect(item.value).toEqual(value);
    expect(item.qualifiers).toEqual(qualifiers);
    expect(item.sources).toContain(source.id);
    if (kind === 'statement') {
      expect(item.statement).toMatch(/^https:\/\/rezics\.com\/id\//);
      expect(item.acceptance).toEqual(expectation.acceptance);
    } else {
      expect(item).not.toHaveProperty('statement');
      expect(item).not.toHaveProperty('acceptance');
    }
    expect(item.evidence?.find(evidence => evidence.id === source.id)).toMatchObject({
      id: source.id, sourceWork: source.sourceWork, representationSha256: source.representationSha256,
      locator: source.locator, rightsBasis: source.rightsBasis, quoteWithheld: source.quoteWithheld,
    });
    if (source.quoteWithheld)
      expect(item.evidence?.find(evidence => evidence.id === source.id)).toHaveProperty('quote', null);
    expect(new Set(item.evidence?.map(evidence => evidence.id)).size).toBe(item.evidence?.length);
  }
}

export async function relations(read: Read, resource: string, corpus: InformationCorpus): Promise<RelationEntry[]> {
  const items: RelationEntry[] = [], cursors = new Set<string>();
  let after: string | null = null;
  do {
    const query = new URLSearchParams({ limit: '1', ...(after ? { after } : {}) });
    const page = await body<{ profile: string; resource: string; items: RelationEntry[]; next: string | null }>(
      read, `${resourcePath(resource, 'relations')}?${query}`);
    expect(page.profile).toBe('resource-relations-v1');
    expect(page.resource).toBe(resource);
    expect(page.items.length).toBeLessThanOrEqual(1);
    noHidden(page, corpus);
    items.push(...page.items);
    after = page.next;
    if (after) {
      expect(cursors.has(after)).toBe(false);
      cursors.add(after);
      expect(cursors.size).toBeLessThan(64);
    }
  } while (after);
  expect(new Set(items.map(item => item.relation)).size).toBe(items.length);
  return items;
}

export function assertEdge(items: RelationEntry[], edge: EdgeExpectation): void {
  const actual = items.find(item => item.relation === edge.relation);
  expect(actual).toMatchObject({ relation: edge.relation, revision: edge.revision,
    applicability: edge.applicability,
    rendering: { meaning: { definition: edge.definition }, viewingRole: edge.viewingRole } });
  expect(actual?.rendering?.projections.some(projection =>
    projection.fromRole === edge.viewingRole && projection.toRole === edge.counterpartRole)).toBe(true);
  expect(actual?.counterparts).toContainEqual(expect.objectContaining({
    reference: edge.counterpart, status: 'available', base: edge.counterpartBase,
  }));
  expect(actual?.rendering?.bindings).toContainEqual(expect.objectContaining({ role: edge.counterpartRole,
    participant: { kind: 'resource', ref: edge.counterpart } }));
  expect(actual?.citations).toContainEqual(expect.objectContaining({ id: edge.source.id,
    representationSha256: edge.source.representationSha256, locator: edge.source.locator }));
}

export async function assertCollectionPurpose(read: Read, corpus: InformationCorpus, key: CollectionKey): Promise<void> {
  const expected = corpus.collections[key], specification = collectionCases[key];
  const memberRelations = await relations(read, expected.member, corpus);
  const membership = memberRelations.find(item => item.kind === 'collection' && item.relation === expected.resource);
  expect(membership, key).toBeDefined();
  expect(membership?.collectionPurpose).toEqual(expected.purpose);
  expect(membership?.collectionPurpose?.kind ?? null).toBe(specification.kind);
  expect(membership?.rendering?.projections.map(projection => projection.labels?.heading)).toContain(specification.heading);
  if (key !== 'franchise')
    expect(membership?.rendering?.projections.map(projection => projection.labels?.heading)).not.toContain('Franchises');
  if (expected.purpose) {
    const facts = await factGroups(read, expected.resource, corpus);
    const assertion = facts.flatMap(group => group.items).find(item => item.statement === expected.purpose?.statement);
    expect(assertion).toMatchObject({ revision: expected.purpose.revision, sources: expected.purpose.sources });
    expect(assertion?.acceptance).toEqual(expect.objectContaining({ context: expect.any(String), decision: expect.any(String) }));
  }
  const occurrences: { occurrence: string; target: string }[] = [], cursors = new Set<string>();
  let after: string | null = null;
  do {
    const query = new URLSearchParams({ limit: '1', ...(after ? { after } : {}) });
    const page = await body<{ collection: string; revision: string;
      occurrences: { occurrence: string; target: string }[]; next: string | null }>(read,
    `/v1/collections/${expected.resource.slice(-36)}?${query}`);
    expect(page.revision).toBe(expected.revision);
    expect(page.occurrences.length).toBeLessThanOrEqual(1);
    noHidden(page, corpus);
    occurrences.push(...page.occurrences);
    after = page.next;
    if (after) {
      expect(cursors.has(after)).toBe(false);
      cursors.add(after);
      expect(cursors.size).toBeLessThan(32);
    }
  } while (after);
  expect(cursors.size).toBeGreaterThan(0);
  expect(occurrences.map(item => ({ occurrence: item.occurrence, target: item.target }))).toEqual(expected.occurrences);
}

export async function command(session: PersonaSession, input: FixtureCommand): Promise<unknown> {
  expect(input.path).toMatch(/^\/v1\//);
  const response = await session.main(input.method, input.path, input.body, input.key);
  const raw = await response.text();
  expect(response.status, raw).toBe(input.status);
  return JSON.parse(raw) as unknown;
}

export const allPersonas: readonly PersonaName[] = ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'];
