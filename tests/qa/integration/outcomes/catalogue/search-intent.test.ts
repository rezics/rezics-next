import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Compile } from 'typebox/schema';
import specification from '../../../../../docs/goals/audit-remediation-20261019/search-intent-outcomes.json';
import searchIntent from '../../../../../scripts/qa/cases/outcomes/catalogue/search-intent.ts';
import {
  createCorpusBackupDriver,
  type CorpusRestoreSmokeInput,
  type ManagedCorpusBackupDriver,
} from '../../../../../scripts/load/corpus-backup-driver.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import {
  restorePersonaRealms,
  type PersonaName,
  type PersonaSession,
  type PersonaSessions,
  type RetainedPersonaRealm,
} from '../../../support/personas.ts';

// This is a proposal, not a replacement implementation or a proof record.
// A missing source fails beforeAll, outside the six pending test bodies.
type Field = 'title' | 'body' | 'credit' | 'label' | 'summary';
type SearchRequest = {
  profile: 'resource-search-v1'; q: string;
  context: 'global' | { realm: string };
  scope: { kind: 'all' } | { kind: 'realm'; realm: string };
  fields?: Field[]; language?: string | null; filter?: unknown;
  sort?: 'relevance' | 'newest' | 'updated'; limit?: number;
  recovery?: 'none' | 'suggest'; cursor?: string;
};
type Selection = Required<Omit<SearchRequest, 'cursor'>>;
type LocalizedText = { value: string; language: string | null };
type SearchItem = {
  id: string; types: string[]; name: LocalizedText;
  summary: LocalizedText | null;
  summaryStatus: 'available' | 'missing' | 'unavailable'; matchedFields: Field[];
};
type SearchPage = {
  profile: 'resource-search-v1'; selection: Selection; items: SearchItem[];
  nextCursor: string | null; complete: boolean;
  count: { value: number; kind: 'exact' | 'at-least' };
  suggestions: { status: 'not-requested' | 'complete' | 'unavailable';
    items: { q: string; kind: 'spelling'; request: Selection }[] };
  sourcePosition: { dataEpoch: string; sequence: string }; indexGeneration: string; stale: false;
};
type CataloguePage = {
  results: { work: string }[]; next: string | null;
  count: { value: number; precision: 'exact' | 'lower-bound' };
};
type EvidenceFile = { path: string; sha256: string };
type Binding = {
  id: string; revision: string; readPath: string;
  namePointer: string; typesPointer: string; summaryPointer: string; revisionPointer: string;
  owner: 'public' | 'private'; evidence: EvidenceFile[];
};
type Source = {
  format: 'rezics-retained-source-v1'; key: string;
  specification: { inputs: { corpusOrigin: 'public-api-command-created' } };
  metadata: { format: 'search-intent-corpus-v1'; namespace: string;
    realms: RetainedPersonaRealm[]; records: Record<string, Binding> };
  provenance: { producerRevision: string; elapsedMs: number; backupPath: string };
};

const nativeId = { type: 'string', pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' };
// Revision coordinates retain the owning API's representation (for example,
// MemberReply revisionId is a UUID, while semantic revisions use native IRIs).
const nativeRevision = { anyOf: [nativeId, { type: 'string', pattern: '^[0-9a-f-]{36}$' }] };
const sourceSchema = Compile({ type: 'object', required: ['format', 'key', 'specification', 'metadata', 'provenance'],
  properties: {
    format: { const: 'rezics-retained-source-v1' }, key: { type: 'string', pattern: '^rs-search-intent-' },
    specification: { type: 'object', required: ['inputs'], properties: {
      inputs: { type: 'object', required: ['corpusOrigin'], properties: {
        corpusOrigin: { const: 'public-api-command-created' },
      } },
    } },
    metadata: { type: 'object', required: ['format', 'namespace', 'realms', 'records'], properties: {
      format: { const: 'search-intent-corpus-v1' }, namespace: { type: 'string', pattern: '^si[0-9a-f]{8}$' },
      realms: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'object',
        required: ['realm', 'space', 'zone', 'visibility', 'identities', 'auth'],
        properties: { realm: nativeId, visibility: { enum: ['public', 'private'] } },
      } },
      records: { type: 'object', additionalProperties: { type: 'object',
        required: ['id', 'revision', 'readPath', 'namePointer', 'typesPointer', 'summaryPointer', 'revisionPointer', 'owner', 'evidence'],
        properties: {
          id: nativeId, revision: nativeRevision, readPath: { type: 'string', pattern: '^/v1/' },
          namePointer: { type: 'string', pattern: '^/' }, typesPointer: { type: 'string', pattern: '^/' },
          summaryPointer: { type: 'string', pattern: '^/' }, owner: { enum: ['public', 'private'] },
          revisionPointer: { type: 'string', pattern: '^/' },
          evidence: { type: 'array', minItems: 1, items: { type: 'object', required: ['path', 'sha256'],
            properties: { path: { type: 'string', minLength: 1 }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
          } },
        },
      } },
    } },
    provenance: { type: 'object', required: ['producerRevision', 'elapsedMs', 'backupPath'], properties: {
      producerRevision: { type: 'string', pattern: '^[a-f0-9]{40}$' },
      elapsedMs: { type: 'number', minimum: 1, maximum: 600_000 }, backupPath: { type: 'string', minLength: 1 },
    } },
  },
});
const requestSchema = Compile(specification.proposal.requestSchema);
const responseSchema = Compile(specification.proposal.responseSchema);
const plans = specification.fixturePlan.records;
const book = 'https://schema.org/Book';
const bookFilter = { all: [{ facet: 'type', any: [book] }] };
const englishBooks = { all: [...bookFilter.all, { facet: 'language', any: ['en'] }] };
const allFields: Field[] = ['title', 'body', 'credit', 'label', 'summary'];
setDefaultTimeout(180_000);
let source: Source, sessions: PersonaSessions, privateSessions: PersonaSessions;
let driver: ManagedCorpusBackupDriver | undefined;
const restoreTarget = `search-intent-${randomUUID().slice(0, 12)}`;

function privateFile(path: string): string {
  const temp = realpathSync(resolve('.temp'));
  const file = realpathSync(resolve(path));
  const local = relative(temp, file);
  if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local))
    throw new Error('Search fixture files must be retained under this worktree .temp/');
  return file;
}
function localized(value: string) { return value.replaceAll('{ns}', source.metadata.namespace); }
function binding(key: string): Binding {
  const record = source.metadata.records[key];
  if (!record) throw new Error(`Search corpus has no ${key} control`);
  return record;
}
function ids(keys: readonly string[]) { return keys.map(key => binding(key).id).sort(); }
function pointer(value: unknown, path: string): unknown {
  return path.slice(1).split('/').reduce<unknown>((current, key) =>
    current && typeof current === 'object'
      ? (current as Record<string, unknown>)[key.replaceAll('~1', '/').replaceAll('~0', '~')]
      : undefined, value);
}
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request, raw = await response.text();
  expect(response.status, `HTTP ${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
function effective(request: SearchRequest): Selection {
  const { cursor: _cursor, ...selected } = request;
  return { fields: allFields, language: null, filter: { all: [] }, sort: 'relevance', limit: 20,
    recovery: 'none', ...selected };
}
function query(q: string, refinements: Partial<SearchRequest> = {}): SearchRequest {
  return { profile: 'resource-search-v1', q: localized(q),
    context: { realm: sessions.realm }, scope: { kind: 'realm', realm: sessions.realm },
    ...refinements };
}
function noPrivateData(value: unknown) {
  // Echoing the caller's q is allowed; suggestions and all result data remain checked.
  const page = value as Partial<SearchPage> | null;
  const raw = JSON.stringify(page?.selection
    ? { ...page, selection: { ...page.selection, q: '[caller input]' } }
    : value);
  for (const plan of plans.filter(record => record.visibility === 'private')) {
    expect(raw, `Private identity ${plan.key}`).not.toContain(binding(plan.key).id);
    expect(raw, `Private label ${plan.key}`).not.toContain(localized(plan.name));
  }
  expect(raw).not.toContain('secretcatalogue');
  expect(raw).not.toContain('shadowlight');
}
async function search(person: PersonaSession, request: SearchRequest): Promise<SearchPage> {
  expect(requestSchema.Check(request), 'Authored request must match the proposal').toBe(true);
  const page = await answer<SearchPage>(person.main('POST', '/v1/query', request));
  expect(responseSchema.Check(page), JSON.stringify(responseSchema.Errors(page)[1])).toBe(true);
  expect(page.selection).toEqual(effective(request));
  expect(page.items.length).toBeLessThanOrEqual(request.limit ?? 20);
  expect(page.complete).toBe(page.nextCursor === null);
  for (const item of page.items) {
    expect(item.matchedFields.every(field => (request.fields ?? allFields).includes(field))).toBe(true);
    if (item.summaryStatus === 'available') expect(item.summary).not.toBeNull();
    else expect(item.summary).toBeNull();
  }
  if (page.complete) expect(page.count.kind).toBe('exact');
  noPrivateData(page);
  return page;
}
async function traverse(person: PersonaSession, request: SearchRequest) {
  const items: SearchItem[] = [], cursors = new Set<string>();
  let cursor: string | undefined, first: SearchPage | undefined, last: SearchPage;
  do {
    last = await search(person, { ...request, ...(cursor ? { cursor } : {}) });
    first ??= last;
    expect(last.sourcePosition).toEqual(first.sourcePosition);
    expect(last.indexGeneration).toBe(first.indexGeneration);
    items.push(...last.items);
    expect(new Set(items.map(item => item.id)).size, 'No repeated logical resources').toBe(items.length);
    expect(last.count.value).toBeGreaterThanOrEqual(items.length);
    if (last.nextCursor) {
      expect(cursors.has(last.nextCursor), 'Cursor must make progress').toBe(false);
      cursors.add(last.nextCursor);
      expect(cursors.size, 'Small corpus must exhaust without a result window').toBeLessThanOrEqual(plans.length);
    }
    cursor = last.nextCursor ?? undefined;
  } while (cursor);
  expect(last.count).toEqual({ value: items.length, kind: 'exact' });
  return { items, first: first!, last };
}
async function expectMatches(person: PersonaSession, request: SearchRequest, keys: string[]) {
  const result = await traverse(person, request);
  expect(result.items.map(item => item.id).sort(), request.q).toEqual(ids(keys));
  return result;
}

async function openRestored(input: CorpusRestoreSmokeInput) {
  const environment = { ...input.apps, REZICS_QA_RUN_ID: input.runId,
    REZICS_QA_STACK_MODE: 'scale', REZICS_QA_STACK_TIER: 'integration', REZICS_STACK_PROFILE: 'qa' };
  const previous = new Map(Object.keys(environment).map(key => [key, Bun.env[key]]));
  Object.assign(Bun.env, environment);
  try {
    const restored = await restorePersonaRealms(source.metadata.realms);
    sessions = restored[0]!; privateSessions = restored[1]!;
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
    }
  }
  try {
    expect(sessions.visibility).toBe('public');
    expect(privateSessions.visibility).toBe('private');
    expect(Object.keys(source.metadata.records).sort()).toEqual(plans.map(plan => plan.key).sort());
    expect(new Set(Object.values(source.metadata.records).map(record => record.id)).size).toBe(plans.length);
    for (const plan of plans) {
      input.signal.throwIfAborted();
      const record = binding(plan.key);
      for (const evidence of record.evidence) {
        const bytes = readFileSync(privateFile(evidence.path));
        expect(createHash('sha256').update(bytes).digest('hex'), `${plan.key} command evidence`).toBe(evidence.sha256);
        const command = JSON.parse(bytes.toString()) as {
          method: string; path: string; status: number; answer: unknown;
        };
        expect(['POST', 'PUT', 'PATCH']).toContain(command.method);
        expect(command.path.startsWith('/v1/')).toBe(true);
        expect(command.status).toBeGreaterThanOrEqual(200);
        expect(command.status).toBeLessThan(300);
        expect(JSON.stringify(command.answer), `${plan.key} real command identity`).toContain(record.id);
      }
      const visitor = await sessions.visitor.main('GET', record.readPath);
      let state: unknown;
      if (plan.visibility === 'private') {
        expect(visitor.status, `${plan.key}: private control is not public`).toBe(404);
        expect(await visitor.text()).not.toContain(localized(plan.name));
        const owner = (record.owner === 'private' ? privateSessions : sessions).owner;
        const path = new URL(record.readPath, 'http://fixture.local');
        path.searchParams.set('actingSubject', owner.actingSubject!);
        state = await answer<unknown>(owner.main('GET', path.pathname + path.search));
      } else state = await answer<unknown>(Promise.resolve(visitor));
      expect(state, `${plan.key}: an empty success is not an admitted fixture`).not.toBeNull();
      expect(JSON.stringify(state)).toContain(record.id);
      expect(pointer(state, record.revisionPointer), `${plan.key}: frozen revision`).toBe(record.revision);
      expect(pointer(state, record.namePointer), `${plan.key}: admitted name`).toBe(localized(plan.name));
      expect(pointer(state, record.typesPointer), `${plan.key}: admitted types`).toEqual(expect.arrayContaining(plan.types));
      if (plan.summary === null) expect(pointer(state, record.summaryPointer) ?? null).toBeNull();
      else expect(pointer(state, record.summaryPointer), `${plan.key}: admitted description`).toBe(localized(plan.summary));
      if (plan.creditText) {
        const credits = await answer<unknown>(sessions.visitor.main('GET',
          `/v1/works/${record.id.slice(-36)}/credits`));
        expect(JSON.stringify(credits), 'The native credit name must really be public').toContain(localized(plan.creditText));
      }
    }
    // Establish an actual absent control independently of an incomplete record.
    const absent = await sessions.visitor.main('GET', `/v1/semantic/resources/${randomUUID()}`);
    expect(absent.status).toBe(404);
  } catch (error) { await sessions.close(); throw error; }
  return () => sessions.close();
}

beforeAll(async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Use goalctl test on one isolated QA selection');
  const path = Bun.env.REZICS_SEARCH_INTENT_CORPUS ?? '.temp/search-intent/corpus-source.json';
  let bytes: Buffer;
  try {
    const file = privateFile(path);
    if (statSync(file).mode & 0o077) throw new Error('Retained personas require a mode-0600 source manifest');
    bytes = readFileSync(file);
  } catch (error) {
    throw new Error('SEARCH01 fixture prerequisite: supply the command-created search-intent retained source '
      + 'and consistent stopped all-owner backup specified in search-intent-outcomes.json; no outcome assertion reached', { cause: error });
  }
  const parsed: unknown = JSON.parse(bytes.toString());
  if (!sourceSchema.Check(parsed)) throw new Error('SEARCH01 source manifest is incomplete; no outcome assertion reached');
  source = parsed as Source;
  const backup = privateFile(source.provenance.backupPath);
  driver = createCorpusBackupDriver({ sourceRunId: Bun.env.REZICS_QA_RUN_ID,
    directory: resolve('.temp/search-intent/copies'), quiesce: async () => {}, smokeRead: openRestored });
  await driver.restore(backup, restoreTarget, AbortSignal.timeout(600_000));
  expect(driver.preparation(restoreTarget)!.totalMs, 'Complete isolated restore preparation budget').toBeLessThanOrEqual(600_000);
  console.info('SEARCH01 source restored', { producerRevision: source.provenance.producerRevision,
    preparation: driver.preparation(restoreTarget), sourceKey: source.key });
}, 600_000);
afterAll(async () => { await driver?.stop(restoreTarget); });

async function catalogueAdapter(person: PersonaSession) {
  const parameters = new URLSearchParams({ q: localized('{ns} amber lantern'), language: 'en',
    realm: sessions.realm, author: sessions.owner.actingSubject!, limit: '1' });
  const seen: string[] = [], cursors = new Set<string>();
  let page: CataloguePage;
  do {
    page = await answer<CataloguePage>(person.main('GET', `/v1/search/catalogue?${parameters}`));
    noPrivateData(page);
    seen.push(...page.results.map(item => item.work));
    expect(new Set(seen).size).toBe(seen.length);
    expect(page.count.value).toBeGreaterThanOrEqual(seen.length);
    if (page.next) {
      expect(cursors.has(page.next)).toBe(false); cursors.add(page.next);
      expect(cursors.size).toBeLessThanOrEqual(plans.length);
      parameters.set('cursor', page.next);
    }
  } while (page.next);
  expect(seen.sort(), 'Catalogue q must not silently require an adjacent ordered phrase')
    .toEqual(ids(['adjacent', 'separated', 'reversed']));
  expect(page.count).toEqual({ value: 3, precision: 'exact' });
  parameters.delete('cursor'); parameters.set('q', localized('{ns} "amber lantern"'));
  parameters.set('limit', '20');
  const phrase = await answer<CataloguePage>(person.main('GET', `/v1/search/catalogue?${parameters}`));
  expect(phrase.results.map(item => item.work)).toEqual(ids(['adjacent']));
  parameters.set('q', 'x');
  const single = await answer<CataloguePage>(person.main('GET', `/v1/search/catalogue?${parameters}`));
  expect(single.results.map(item => item.work)).toEqual(ids(['oneCharacter']));
  parameters.set('q', localized('{ns} amber lantern')); parameters.set('author', sessions.member.actingSubject!);
  expect((await answer<CataloguePage>(person.main('GET', `/v1/search/catalogue?${parameters}`))).results).toEqual([]);
  // Explicit phrase operations retain their declared meaning during the q change.
  const legacy = await answer<{ results: { work: string }[] }>(person.main('POST', '/v1/queries', {
    profile: 'public-realm-phrase-v1', context: { kind: 'realm-local', id: sessions.realm },
    phrase: localized('{ns} amber lantern'), language: 'en',
  }));
  expect(legacy.results.map(item => item.work)).toEqual(ids(['adjacent']));
}
async function keywordsAndPhrases(person: PersonaSession) {
  const selection = { fields: ['title'] as Field[], language: 'en', filter: bookFilter };
  for (const q of ['{ns} amber lantern', '{ns} lantern amber'])
    await expectMatches(person, query(q, selection), ['adjacent', 'separated', 'reversed']);
  await expectMatches(person, query('{ns} "amber lantern"', selection), ['adjacent']);
  await expectMatches(person, query('{ns} "lantern amber"', selection), ['reversed']);
  await expectMatches(person, query('{ns} "amber quiet" lantern', selection), ['separated']);
  await expectMatches(person, query('{ns} amber lantern', { ...selection,
    context: 'global', scope: { kind: 'all' } }), ['adjacent', 'separated', 'reversed', 'outsideRealm']);
  await expectMatches(person, query('{ns} amber lantern', { ...selection, language: null }),
    ['adjacent', 'separated', 'reversed', 'foreign']);
  const rejected = await answer<{ code: string }>(person.main('POST', '/v1/query',
    query('{ns} "amber lantern', selection)), 400);
  expect(rejected.code).toBe('invalid_query');
}
async function unicodeAndLanguages(person: PersonaSession) {
  for (const [q, language, key] of [
    ['{ns} café résumé', 'fr', 'unicode'], ['{ns} cafe\u0301 re\u0301sume\u0301', 'fr', 'unicode'],
    ['星', 'ja', 'japanese'], ['星 旅', 'ja', 'japanese'], ['山', 'zh-Hant', 'chinese'],
    ['x', 'en', 'oneCharacter'], ['{ns} safari njema', 'sw', 'nonUiLanguage'],
  ] as const) {
    await expectMatches(person, query(q, { language, fields: ['title'], filter: bookFilter }), [key]);
  }
  const request = query('{ns} safari njema', { language: 'sw', fields: ['title'], filter: bookFilter });
  const response = await answer<SearchPage>(person.main('POST', '/v1/query', request, undefined,
    { headers: { 'accept-language': 'de', 'x-rezics-display-languages': 'en' } }));
  expect(responseSchema.Check(response)).toBe(true);
  expect(response.items.map(item => item.id)).toEqual(ids(['nonUiLanguage']));
  expect(response.selection.language).toBe('sw');
  noPrivateData(response);
}
async function fieldsAndPreservedFilters(person: PersonaSession) {
  const selection = { language: 'en', filter: bookFilter };
  await expectMatches(person, query('{ns} cobalt otter', { ...selection, fields: ['title'] }), ['titleOnly']);
  await expectMatches(person, query('{ns} cobalt otter', { ...selection, fields: ['body'] }), ['bodyOnly']);
  await expectMatches(person, query('{ns} cobalt otter', { ...selection, fields: ['title', 'body'] }),
    ['titleOnly', 'bodyOnly', 'crossField']);
  await expectMatches(person, query('{ns} "cobalt otter"', { ...selection, fields: ['title', 'body'] }),
    ['titleOnly', 'bodyOnly']);
  await expectMatches(person, query('{ns} creditkeeper', { ...selection, fields: ['credit'] }), ['creditOnly']);
  await expectMatches(person, query('{ns} creditkeeper', { ...selection, fields: ['title', 'body'] }), []);
  const before = query('{ns} amber lantern', { fields: ['title'], language: 'en', filter: englishBooks, limit: 1 });
  const first = await expectMatches(person, before, ['adjacent', 'separated', 'reversed']);
  expect(first.first.nextCursor).not.toBeNull();
  const edited = { ...before, q: localized('{ns} cobalt otter') };
  const after = await expectMatches(person, edited, ['titleOnly']);
  expect(after.first.selection).toEqual({ ...first.first.selection, q: edited.q });
  expect(before.filter).toEqual(englishBooks);
}
async function namedResources(person: PersonaSession) {
  const characters = await expectMatches(person,
    query('{ns} Mira', { fields: ['label'], language: 'en' }), ['characterKeeper', 'characterArchivist']);
  for (const key of ['characterKeeper', 'characterArchivist']) {
    const actual = characters.items.find(item => item.id === binding(key).id)!;
    const plan = plans.find(record => record.key === key)!;
    expect(actual.name.value).toBe(localized(plan.name));
    expect(actual.types).toEqual(expect.arrayContaining(plan.types));
    expect(actual.summaryStatus).toBe('available');
    expect(actual.summary?.value).toBe(plan.summary);
  }
  expect(new Set(characters.items.map(item => item.summary?.value)).size).toBe(2);
  for (const [q, field, keys] of [
    ['{ns} astronomy', 'label', ['concept', 'discussion']],
    ['{ns} beacon', 'label', ['additionalType']],
    ['bridge keeper', 'summary', ['characterKeeper']],
    ['bridge keeper', 'label', []],
  ] as const) await expectMatches(person, query(q, { fields: [field], language: 'en' }), [...keys]);
  const incomplete = await expectMatches(person, query('{ns} fogwatch', { fields: ['label'] }), ['incomplete']);
  expect(incomplete.items[0]).toMatchObject({ id: binding('incomplete').id,
    name: { value: localized('{ns} fogwatch') }, types: ['https://rezics.com/vocab/Character'],
    summary: null, summaryStatus: 'missing' });
}
async function privateControlsAndRecovery(person: PersonaSession, name: PersonaName) {
  // The owner control is a different, explicit authorized read. Public query requests never pass actingSubject.
  if (name === 'owner') {
    const privateWork = binding('privateDraft');
    const path = new URL(privateWork.readPath, 'http://fixture.local');
    path.searchParams.set('actingSubject', person.actingSubject!);
    const owned = await answer<unknown>(person.main('GET', path.pathname + path.search));
    expect(pointer(owned, privateWork.namePointer)).toBe(localized('{ns} amber lantern secretcatalogue'));
  }
  // Keep the existing bounded typeahead honest as well as the new correction response.
  for (const prefix of ['{ns} amber', '{ns} shad']) {
    const page = await answer<{ items: { work: string }[] }>(person.main('GET',
      `/v1/search/typeahead?${new URLSearchParams({ prefix: localized(prefix), language: 'en' })}`));
    noPrivateData(page);
    expect(page.items.length).toBeLessThanOrEqual(10);
    if (prefix === '{ns} shad') expect(page.items).toEqual([]);
    else expect(page.items.some(item => item.work === binding('adjacent').id)).toBe(true);
  }
  for (const q of ['{ns} secretcatalogue', '{ns} shadowlight', '{ns} shadowligth']) {
    const privateSearch = await expectMatches(person, query(q, { recovery: 'suggest' }), []);
    expect(privateSearch.first.suggestions).toEqual({ status: 'complete', items: [] });
  }
  const original = query('{ns} astronmy', { fields: ['label'], language: 'en', recovery: 'none', limit: 1,
    filter: { all: [{ facet: 'type', any: ['http://www.w3.org/2004/02/skos/core#Concept',
      'https://rezics.com/vocab/MemberReply'] }] } });
  const exact = await expectMatches(person, original, []);
  expect(exact.first.suggestions).toEqual({ status: 'not-requested', items: [] });
  const optedIn = { ...original, recovery: 'suggest' as const };
  const offered = await expectMatches(person, optedIn, []);
  expect(offered.first.suggestions.status).toBe('complete');
  expect(offered.first.suggestions.items.length).toBeGreaterThan(0);
  expect(offered.first.suggestions.items.length).toBeLessThanOrEqual(3);
  const spelling = offered.first.suggestions.items.find(item => item.q === localized('{ns} astronomy'));
  expect(spelling, 'The small misspelling has an explicit useful recovery request').toBeDefined();
  for (const suggestion of offered.first.suggestions.items) {
    expect(suggestion.request).toEqual({ ...effective(optedIn), q: suggestion.q, recovery: 'none' });
    expect(Object.hasOwn(suggestion.request, 'cursor')).toBe(false);
    expect(suggestion.kind).toBe('spelling');
    const applied = await traverse(person, suggestion.request);
    expect(applied.items.length, 'Every correction has a public match in the original selection').toBeGreaterThan(0);
  }
  await expectMatches(person, spelling!.request, ['concept', 'discussion']);
  expect(offered.first.selection.q).toBe(localized('{ns} astronmy'));
}
async function boundContinuation(person: PersonaSession) {
  const request = query('{ns} amber lantern', { fields: ['title'], language: 'en', filter: englishBooks,
    sort: 'relevance', limit: 1 });
  const first = await search(person, request);
  expect(first.nextCursor).not.toBeNull();
  for (const changed of [
    { q: localized('{ns} "amber lantern"') }, { fields: ['body'] as Field[] }, { language: 'ja' },
    { context: 'global' as const, scope: { kind: 'all' as const } },
    { filter: { all: [{ facet: 'type', any: ['https://rezics.com/vocab/Character'] }] } },
    { sort: 'newest' as const }, { limit: 2 },
  ]) {
    const problem = await answer<{ code: string }>(person.main('POST', '/v1/query',
      { ...request, ...changed, cursor: first.nextCursor }), 400);
    expect(problem.code).toBe('invalid_work_read');
    noPrivateData(problem);
  }
  // A valid continuation remains useful after refused attempts to reuse its selection.
  const continued = await search(person, { ...request, cursor: first.nextCursor! });
  expect(continued.items).toHaveLength(1);
  expect(continued.items[0]!.id).not.toBe(first.items[0]!.id);
  const full = await expectMatches(person, request, ['adjacent', 'separated', 'reversed']);
  expect(full.last.complete).toBe(true);
}

async function searchIntentFor(name: PersonaName) {
  const person = sessions[name];
  const checks = [
    ['catalogue adapter', () => catalogueAdapter(person)],
    ['keywords and phrases', () => keywordsAndPhrases(person)],
    ['Unicode and languages', () => unicodeAndLanguages(person)],
    ['fields and preserved filters', () => fieldsAndPreservedFilters(person)],
    ['named resources and incomplete metadata', () => namedResources(person)],
    ['private controls and explicit recovery', () => privateControlsAndRecovery(person, name)],
    ['bound continuation', () => boundContinuation(person)],
  ] as const;
  const failures: Error[] = [];
  for (const [label, check] of checks) {
    try { await check(); }
    catch (cause) {
      const error = new Error(`SEARCH01 ${name}: ${label}`, { cause });
      failures.push(error);
      console.error(error, cause);
    }
  }
  if (failures.length) throw new AggregateError(failures, `SEARCH01 ${name}: pending search contract failures`);
}

outcomeTest(searchIntent, 'visitor', () => searchIntentFor('visitor'));
outcomeTest(searchIntent, 'stranger', () => searchIntentFor('stranger'));
outcomeTest(searchIntent, 'member', () => searchIntentFor('member'));
outcomeTest(searchIntent, 'owner', () => searchIntentFor('owner'));
outcomeTest(searchIntent, 'moderator', () => searchIntentFor('moderator'));
outcomeTest(searchIntent, 'operator', () => searchIntentFor('operator'));
