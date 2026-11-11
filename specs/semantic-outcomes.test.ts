import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fromPlainText } from '@rezics/document';
import type {
  Candidate,
  HttpResponse,
  Json,
  Persona,
  Release,
  SemanticDriver,
  Statement,
  StatementInput,
  Subject,
} from './semantic-driver';

setDefaultTimeout(60_000);
let driver: SemanticDriver;
const relationProperties = new Map<string, Set<string>>();
const relationTargets = new Map<string, Set<string>>();
const relationCandidateTargets = new Map<string, string>();
const releasedRelationProperties = new Map<string, Set<string>>();
const relationKey = (id: string, property: string) => `${id}\n${property}`;
const candidateKey = (id: string, property: string, candidate: string) => `${id}\n${property}\n${candidate}`;
beforeEach(async () => {
  relationProperties.clear();
  relationTargets.clear();
  relationCandidateTargets.clear();
  releasedRelationProperties.clear();
  const location = process.env.SEMANTIC_DRIVER;
  if (!location) throw new Error('Semantic outcome driver is required');
  if (!isAbsolute(location) && !location.startsWith('file:'))
    throw new Error('SEMANTIC_DRIVER must be absolute or a file URL');
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('SEMANTIC_DRIVER must use a file URL');
  const binding = await import(url.href);
  if (typeof binding.createSemanticDriver !== 'function') throw new Error('Expected createSemanticDriver factory');
  driver = await binding.createSemanticDriver();
});
afterEach(async () => {
  const current = driver;
  driver = undefined!;
  await current?.close();
});
const key = () => `"${randomUUID()}"`;
const write = (persona: Persona, method: 'POST' | 'PUT', path: string, body: unknown, token = key()) => {
  let requestBody = body;
  const adoption = method === 'POST' && path.match(/^\/v1\/subjects\/([^/:]+):adopt$/);
  if (adoption && body && typeof body === 'object' && !Array.isArray(body)) {
    const input = body as Record<string, unknown>;
    const id = adoption[1]!;
    const property = typeof input.property === 'string' ? input.property : '';
    const targets = relationTargets.get(relationKey(id, property));
    if (relationProperties.get(id)?.has(property) && !input.target && !input.sameAs) {
      const selected = Array.isArray(input.selection)
        ? [
            ...new Set(
              input.selection.flatMap((item) => {
                if (
                  !item ||
                  typeof item !== 'object' ||
                  typeof (item as { candidate?: unknown }).candidate !== 'string'
                )
                  return [];
                const target = relationCandidateTargets.get(
                  candidateKey(id, property, (item as { candidate: string }).candidate),
                );
                return target ? [target] : [];
              }),
            ),
          ]
        : [];
      const target =
        selected.length === 1
          ? selected[0]
          : selected.length === 0 && targets?.size === 1
            ? [...targets][0]
            : undefined;
      if (target) requestBody = { ...input, target };
    }
  }
  return driver.request(persona, method, path, requestBody, { 'Idempotency-Key': token });
};
const get = (path: string, persona: Persona = 'anonymous') => driver.request(persona, 'GET', path);
const subjectPath = (id: string) => `/v1/subjects/${id}`;
const value = (content: Json) => ({ type: 'value' as const, content });
const statement = (property: string, content: Json, rank: 'normal' | 'preferred' = 'normal'): StatementInput => ({
  property: { id: property },
  value: value(content),
  rank,
});
const part = (property: string, content: Json) => ({ property: { id: property }, value: value(content) });
const reference = (url = 'https://www.aozora.gr.jp/cards/000148/card773.html') => ({
  parts: [part('schema:url', url)],
});
const time = (date: string) => ({
  time: `+${date}T00:00:00Z`,
  precision: 11,
  calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
});
function problem(response: HttpResponse, status: number, code: string, writeRequest = true) {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  expect(response.body).toMatchObject({
    type: `https://rezics.com/problems/${code}`,
    status,
    code,
    title: expect.any(String),
    request_id: expect.any(String),
    effect_status: writeRequest ? 'not_applied' : 'not_applicable',
    retryable: expect.any(Boolean),
  });
}
function field(response: HttpResponse, pointer: string, code: string) {
  problem(response, 400, 'invalid_request');
  expect(response.body.errors).toEqual(expect.arrayContaining([{ pointer, code }]));
}
async function active() {
  const response = await get('/v1/definitions/active');
  expect(response.status).toBe(200);
  const pointer = response.body as { digest: string; head: number };
  expect(pointer.digest).toEqual(expect.any(String));
  expect(Number.isInteger(pointer.head)).toBe(true);
  return pointer;
}
async function relationPropertiesFor(subject: Pick<Subject, 'release' | 'type'>) {
  const key = `${subject.release}\n${subject.type}`;
  const cached = releasedRelationProperties.get(key);
  if (cached) return cached;
  const response = await get(`/v1/definitions/releases/${subject.release}`, 'editor');
  expect(response.status).toBe(200);
  const release = response.body.release as {
    types: Record<string, { properties: string[] }>;
    properties: Record<string, { relation?: unknown }>;
  };
  const type = release.types[subject.type];
  expect(type).toBeDefined();
  const properties = new Set(type!.properties.filter((property) => release.properties[property]?.relation != null));
  releasedRelationProperties.set(key, properties);
  return properties;
}
async function create(type: string, label: string, statements: Record<string, StatementInput[]> = {}) {
  const response = await write('editor', 'POST', '/v1/subjects', { type, labels: { en: label }, statements });
  expect(response.status).toBe(201);
  const subject = response.body.subject as Subject;
  const properties = await relationPropertiesFor(subject);
  relationProperties.set(subject.id, properties);
  for (const property of properties) {
    const entries = statements[property] ?? [];
    const created = subject.statements[property] ?? [];
    for (let index = 0; index < entries.length; index++) {
      const target = entries[index]?.value.type === 'value' ? entries[index]?.value.content : undefined;
      const candidate = created[index]?.id;
      if (typeof target !== 'string') continue;
      const targets = relationTargets.get(relationKey(subject.id, property)) ?? new Set<string>();
      targets.add(target);
      relationTargets.set(relationKey(subject.id, property), targets);
      if (candidate) relationCandidateTargets.set(candidateKey(subject.id, property, candidate), target);
    }
  }
  expect(response.headers.get('location')).toBe(subjectPath(subject.id));
  expect(response.headers.get('etag')).toBe('"1"');
  expect(response.headers.get('rezics-session-token')).toBeTruthy();
  return subject;
}
async function read(id: string, context?: string, persona: Persona = context ? 'acceptor' : 'editor') {
  const response = await get(`${subjectPath(id)}${context ? `?context=${encodeURIComponent(context)}` : ''}`, persona);
  expect(response.status).toBe(200);
  const subject = response.body.subject as Subject;
  expect(response.headers.get('etag')).toBe(`"${subject.revision}"`);
  return {
    subject,
    related: response.body.related as Record<
      string,
      { labels: Record<string, string>; redirect?: string; type?: string; types?: string[]; cover?: Json }
    >,
  };
}
async function candidates(id: string, property: string, context = driver.globalContext, target?: string) {
  const knownTargets = relationTargets.get(relationKey(id, property));
  const scopedTarget = target ?? (knownTargets?.size === 1 ? [...knownTargets][0] : undefined);
  const scope = scopedTarget ? `&target=${encodeURIComponent(scopedTarget)}` : '';
  const response = await get(
    `${subjectPath(id)}/candidates?property=${encodeURIComponent(property)}&context=${context}${scope}`,
  );
  expect(response.status).toBe(200);
  expect(response.body.next).toBeNull();
  return response.body.candidates as Candidate[];
}
type SourcedCandidate = Candidate & {
  source: {
    source: string;
    external_id: string;
    record_revision: string;
    digest: string;
    converter_revision: string;
    field_group: 'facts' | 'summary' | 'cover';
  } | null;
};
type SourcedCandidatePage = {
  candidates: SourcedCandidate[];
  adoption: { mode: 'replace' | 'inherit' | 'suppress'; head: number } | null;
  next: string | null;
};
async function candidatePage(id: string, property: string, context: string, target?: string) {
  const query = new URLSearchParams({ property, context });
  if (target) query.set('target', target);
  const response = await get(`${subjectPath(id)}/candidates?${query}`);
  expect(response.status).toBe(200);
  expect(response.body.next).toBeNull();
  return response.body as unknown as SourcedCandidatePage;
}
async function propose(id: string, property: string, content: Json) {
  const input = { ...statement(property, content), references: [reference()] };
  const token = key();
  const path = `${subjectPath(id)}/candidates`;
  const response = await write('editor', 'POST', path, { statement: input }, token);
  expect(response.status).toBe(201);
  if (relationProperties.get(id)?.has(property) && typeof content === 'string') {
    const targets = relationTargets.get(relationKey(id, property)) ?? new Set<string>();
    targets.add(content);
    relationTargets.set(relationKey(id, property), targets);
    relationCandidateTargets.set(candidateKey(id, property, response.body.candidate as string), content);
  }
  await unchanged(id, async () => {
    const replay = await write('editor', 'POST', path, { statement: input }, token);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(response.body);
    problem(
      await write(
        'editor',
        'POST',
        path,
        { statement: { ...input, references: [reference('https://www.aozora.gr.jp/')] } },
        token,
      ),
      422,
      'idempotency_conflict',
    );
  });
  return { candidate: response.body.candidate as string, revision: response.body.revision as number, input };
}
const activationPath = (digest: string) => `/v1/definitions/releases/${digest}:activate`;
const acceptancePath = (id: string, candidate: string, decision: 'accept' | 'reject' = 'accept') =>
  `${subjectPath(id)}/candidates/${candidate}:${decision}`;
const adoptionPath = (id: string) => `${subjectPath(id)}:adopt`;
const mergePath = '/v1/subjects:merge';
async function accept(
  id: string,
  candidate: string,
  decision: 'accept' | 'reject' = 'accept',
  context = driver.globalContext,
) {
  const response = await write('acceptor', 'POST', acceptancePath(id, candidate, decision), {
    context,
    expected_head: null,
  });
  expect(response.status).toBe(200);
  expect(response.body.acceptance).toMatchObject({ context, decision, head: expect.any(Number) });
  return response;
}
const selection = (candidate: string, rank: 'normal' | 'preferred' = 'normal') => ({ candidate, rank });
async function authoredBook() {
  const author = await create('schema:Person', 'Natsume Sōseki');
  const book = await create('schema:Book', 'Kokoro', {
    'schema:author': [{ ...statement('schema:author', author.id, 'preferred'), references: [reference()] }],
  });
  return { author, book, original: (await candidates(book.id, 'schema:author'))[0]! };
}
async function unchanged(id: string, action: () => Promise<void>) {
  const before = await read(id);
  const revisions = await driver.inspect.revisions(id);
  await action();
  expect(await read(id)).toEqual(before);
  expect(await driver.inspect.revisions(id)).toEqual(revisions);
}
async function community(label = 'Literature readers') {
  const token = key();
  const body = { labels: { en: label } };
  const response = await write('editor', 'POST', '/v1/contexts', body, token);
  expect(response.status).toBe(201);
  const context = response.body.context as {
    id: string;
    kind: string;
    labels: Record<string, string>;
    settings: null;
    defaults: Record<string, unknown>;
  };
  expect(context).toEqual({
    id: expect.any(String),
    kind: 'community',
    labels: { en: label },
    settings: null,
    defaults: {},
  });
  const replay = await write('editor', 'POST', '/v1/contexts', body, token);
  expect(replay.status).toBe(201);
  expect(replay.body).toEqual(response.body);
  problem(
    await write('editor', 'POST', '/v1/contexts', { labels: { en: 'Different community' } }, token),
    422,
    'idempotency_conflict',
  );
  expect((await get(`/v1/contexts/${context.id}`)).body).toEqual({ context });
  return context.id;
}
function shape(s: Statement, property: string, dataType: string, content: Json, release: string, revision = 1) {
  expect(s).toMatchObject({
    id: expect.any(String),
    rank: expect.stringMatching(/^(normal|preferred)$/),
    property: { id: property, data_type: dataType },
    value: value(content),
    qualifiers: expect.any(Array),
    references: expect.any(Array),
    rezics: { release, revision },
  });
  for (const ref of s.references) expect(ref).toMatchObject({ hash: expect.any(String), parts: expect.any(Array) });
}
// Release envelopes are compiler-owned. Locate semantic entries without imposing
// an extra release serialization format; assert facts inside their own entry.
function entry(root: Json, id: string): Json {
  if (root && typeof root === 'object') {
    if (!Array.isArray(root) && id in root) return root[id]!;
    if (!Array.isArray(root) && (root.id === id || root.class_uri === id || root.slot_uri === id)) return root;
    for (const child of Object.values(root)) {
      const found = entry(child, id);
      if (found !== null) return found;
    }
  }
  return null;
}
function contains(root: Json, expected: Json): boolean {
  return JSON.stringify(root).includes(JSON.stringify(expected));
}
async function music() {
  const labels = {
    de: 'Musikkomposition',
    en: 'Musical composition',
    es: 'Composición musical',
    fr: 'Composition musicale',
    ja: '楽曲',
    ko: '음악 작품',
    'zh-Hans': '音乐作品',
    'zh-Hant': '音樂作品',
  };
  return driver.compile(
    'fixture.yaml',
    {
      'fixture.yaml': `id: https://rezics.com/fixtures/catalogue
name: fixture
version: 1.0.0
prefixes:
  linkml: https://w3id.org/linkml/
  schema: http://schema.org/
  wd: http://www.wikidata.org/entity/
imports: [linkml:types, rezics, music-fixture]
`,
      'music-fixture.yaml': String.raw`id: https://rezics.com/fixtures/music
name: music-fixture
version: 1.0.0
prefixes:
  linkml: https://w3id.org/linkml/
  schema: http://schema.org/
  wd: http://www.wikidata.org/entity/
default_range: string
imports: [linkml:types, core, book]
classes:
  Composition:
    is_a: CreativeWork
    class_uri: schema:MusicComposition
    exact_mappings: [wd:Q207628]
    slots: [author]
`,
    },
    Object.fromEntries(
      Object.entries(labels).map(([locale, label]) => [
        `music-fixture/${locale}`,
        { types: { 'schema:MusicComposition': label } },
      ]),
    ),
  );
}

test('Anonymous reads the active pointer and the complete bundled catalogue with immutable caching', async () => {
  const { digest } = await active();
  const response = await get(`/v1/definitions/releases/${digest}`);
  expect(response.status).toBe(200);
  expect(response.headers.get('etag')).toBe(`"${digest}"`);
  expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  expect(response.body.digest).toBe(digest);
  const release = response.body.release as Release;
  for (const id of ['schema:Book', 'bf:Instance', 'schema:Recipe', 'schema:Person', 'schema:Organization']) {
    expect(entry(release, id)).not.toBeNull();
  }
  expect(contains(entry(release, 'schema:Book'), 'wd:Q47461344')).toBe(true);
  expect(contains(entry(release, 'bf:Instance'), 'wd:Q3331189')).toBe(true);
  const author = entry(release, 'schema:author');
  for (const fact of ['wikibase-item', 'schema:Person', 'schema:Organization', 'schema:position'])
    expect(contains(author, fact)).toBe(true);
  expect(author).toMatchObject({ multivalued: true });
  expect(contains(entry(release, 'schema:datePublished'), 'time')).toBe(true);
  expect(contains(entry(release, 'schema:url'), 'url')).toBe(true);
  const work = entry(release, 'schema:exampleOfWork');
  expect(work).toMatchObject({ multivalued: false });
  expect(contains(work, 'wikibase-item') && contains(work, 'schema:CreativeWork')).toBe(true);
  expect((entry(release, 'schema:Book') as { bases: string[] }).bases).toContain('schema:CreativeWork');
  expect(contains(entry(release, 'schema:isbn'), 'external-id')).toBe(true);
  expect(contains(entry(release, 'schema:isbn'), 'wd:P212')).toBe(true);
  const pages = entry(release, 'schema:numberOfPages');
  expect(pages).toMatchObject({ datatype: 'quantity', units: ['1'], minimum: 1 });
  const ingredient = entry(release, 'schema:recipeIngredient');
  expect(ingredient).toMatchObject({ multivalued: true });
  expect(contains(ingredient, 'monolingualtext')).toBe(true);
});

test('Steward publishes and activates a compiled music catalogue and editor uses its data alongside books', async () => {
  const before = await active();
  const compiled = await music();
  const fixtureRelease = compiled.release as unknown as {
    types: Record<string, { labels: Record<string, string> }>;
  };
  expect(Object.keys(fixtureRelease.types['schema:MusicComposition']!.labels).sort()).toEqual(
    ['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'].sort(),
  );
  const publishKey = key();
  const published = await write(
    'steward',
    'POST',
    '/v1/definitions/releases',
    { release: compiled.release },
    publishKey,
  );
  expect(published.status).toBe(201);
  expect(published.body).toEqual({ digest: compiled.digest });
  const publishReplay = await write(
    'steward',
    'POST',
    '/v1/definitions/releases',
    { release: compiled.release },
    publishKey,
  );
  expect(publishReplay.status).toBe(201);
  expect(publishReplay.body).toEqual(published.body);
  const again = await write('steward', 'POST', '/v1/definitions/releases', { release: compiled.release });
  expect(again.status).toBe(200);
  expect(again.body).toEqual(published.body);
  expect((await get(`/v1/definitions/releases/${compiled.digest}`)).body).toEqual(compiled);
  const activateKey = key();
  const activation = { expected_head: before.head };
  const activated = await write('steward', 'POST', activationPath(compiled.digest), activation, activateKey);
  expect(activated.status).toBe(200);
  expect(activated.body).toEqual({ digest: compiled.digest, head: before.head + 1 });
  const activateReplay = await write('steward', 'POST', activationPath(compiled.digest), activation, activateKey);
  expect(activateReplay.status).toBe(200);
  expect(activateReplay.body).toEqual(activated.body);
  problem(
    await write('steward', 'POST', activationPath(before.digest), activation, activateKey),
    422,
    'idempotency_conflict',
  );
  problem(
    await write('steward', 'POST', activationPath(before.digest), { expected_head: before.head }),
    409,
    'stale_editorial_head',
  );
  expect(await active()).toEqual({ digest: compiled.digest, head: before.head + 1 });
  const composer = await create('schema:Person', 'Ludwig van Beethoven');
  const composition = await create('schema:MusicComposition', 'Symphony No. 5', {
    'schema:author': [statement('schema:author', composer.id)],
  });
  const result = await read(composition.id);
  expect(result.subject.release).toBe(compiled.digest);
  expect(result.related[composer.id]).toEqual({
    labels: composer.labels,
    type: 'schema:Person',
    types: ['schema:Person', 'schema:Thing'],
    cover: null,
  });
  shape(
    result.subject.statements['schema:author']![0]!,
    'schema:author',
    'wikibase-item',
    composer.id,
    compiled.digest,
  );
  const recipe = await create('schema:Recipe', 'Miso soup');
  field(
    await write('editor', 'POST', '/v1/subjects', {
      type: 'schema:MusicComposition',
      labels: { en: 'Invalid author target' },
      statements: { 'schema:author': [statement('schema:author', recipe.id)] },
    }),
    '/statements/schema:author/0/value/content',
    'out_of_range',
  );
  expect((await read((await create('schema:Book', 'Botchan')).id)).subject.release).toBe(compiled.digest);
});

test('Editor anonymous and suspended cannot publish or activate definitions and invalid releases are not stored', async () => {
  const pointer = await active();
  const compiled = await music();
  for (const [persona, status, code] of [
    ['editor', 403, 'forbidden'],
    ['anonymous', 403, 'platform_closed'],
    ['suspended', 401, 'invalid_credentials'],
  ] as const) {
    problem(await write(persona, 'POST', '/v1/definitions/releases', { release: compiled.release }), status, code);
    problem(
      await write(persona, 'POST', activationPath(pointer.digest), { expected_head: pointer.head }),
      status,
      code,
    );
    expect(await active()).toEqual(pointer);
  }
  problem(await get(`/v1/definitions/releases/${compiled.digest}`), 404, 'not_found', false);
  // A claimed digest without compiled artifacts cannot store a release at that
  // digest or change the pointer; the server must validate and compute it.
  const empty = await write('steward', 'POST', '/v1/definitions/releases', { release: { digest: compiled.digest } });
  problem(empty, 400, 'invalid_request');
  expect(
    (empty.body.errors as { pointer: string }[]).every(
      (e) => e.pointer === '/release' || e.pointer.startsWith('/release/'),
    ),
  ).toBe(true);
  expect((empty.body.errors as unknown[]).length).toBeGreaterThan(0);
  problem(await get(`/v1/definitions/releases/${compiled.digest}`), 404, 'not_found', false);
  const unpublished = await write('steward', 'POST', activationPath(compiled.digest), { expected_head: pointer.head });
  problem(unpublished, 404, 'not_found');
  expect(await active()).toEqual(pointer);
});

test('Editor creates a work edition and recipe in Wikibase shape and creation keys replay without new revisions', async () => {
  const { digest } = await active();
  const person = await create('schema:Person', 'Natsume Sōseki');
  const author = {
    ...statement('schema:author', person.id, 'preferred'),
    qualifiers: [part('schema:position', '1')],
    references: [reference()],
  };
  const body = {
    type: 'schema:Book',
    labels: { en: 'Kokoro', ja: 'こころ' },
    descriptions: { en: 'A novel by Natsume Sōseki' },
    aliases: { en: ['The Heart'] },
    statements: { 'schema:author': [author] },
  };
  const token = key();
  const first = await write('editor', 'POST', '/v1/subjects', body, token);
  expect(first.status).toBe(201);
  const work = first.body.subject as Subject;
  const edition = await create('bf:Instance', 'Kokoro, Penguin Classics', {
    'schema:exampleOfWork': [statement('schema:exampleOfWork', work.id)],
    'schema:isbn': [statement('schema:isbn', '9780143106036')],
    'schema:numberOfPages': [statement('schema:numberOfPages', { amount: '+256', unit: '1' })],
    'schema:datePublished': [statement('schema:datePublished', time('2010-02-23'))],
  });
  const recipe = await create('schema:Recipe', 'Miso soup', {
    'schema:recipeIngredient': [
      statement('schema:recipeIngredient', { language: 'en', text: '2 tablespoons miso paste' }),
    ],
  });
  for (const created of [work, edition, recipe]) {
    const result = await read(created.id);
    expect(result.subject).toEqual(created);
    expect(created).toMatchObject({ revision: 1, release: digest, context: driver.globalContext, resolution: {} });
  }
  const result = await read(work.id);
  shape(result.subject.statements['schema:author']![0]!, 'schema:author', 'wikibase-item', person.id, digest);
  expect(result.subject.statements['schema:author']![0]!.qualifiers).toMatchObject(author.qualifiers);
  expect(result.related[person.id]).toEqual({
    labels: person.labels,
    type: 'schema:Person',
    types: ['schema:Person', 'schema:Thing'],
    cover: null,
  });
  expect(result.related['schema:author']!.labels.en).toBeTruthy();
  expect(result.related['schema:url']!.labels.en).toBeTruthy();
  shape(edition.statements['schema:exampleOfWork']![0]!, 'schema:exampleOfWork', 'wikibase-item', work.id, digest);
  shape(edition.statements['schema:datePublished']![0]!, 'schema:datePublished', 'time', time('2010-02-23'), digest);
  shape(
    edition.statements['schema:numberOfPages']![0]!,
    'schema:numberOfPages',
    'quantity',
    { amount: '+256', unit: '1' },
    digest,
  );
  expect((await read(edition.id)).related[work.id]).toEqual({
    labels: work.labels,
    type: 'schema:Book',
    types: ['schema:Book', 'schema:CreativeWork', 'schema:Thing'],
    cover: null,
  });
  shape(edition.statements['schema:isbn']![0]!, 'schema:isbn', 'external-id', '9780143106036', digest);
  shape(
    recipe.statements['schema:recipeIngredient']![0]!,
    'schema:recipeIngredient',
    'monolingualtext',
    { language: 'en', text: '2 tablespoons miso paste' },
    digest,
  );
  await unchanged(work.id, async () => {
    const replay = await write('editor', 'POST', '/v1/subjects', body, token);
    expect(replay.status).toBe(first.status);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers.get('location')).toBe(first.headers.get('location'));
    expect(replay.headers.get('etag')).toBe('"1"');
    problem(
      await write('editor', 'POST', '/v1/subjects', { ...body, labels: { en: 'Another book' } }, token),
      422,
      'idempotency_conflict',
    );
  });
});

test('Invalid subject types properties values targets qualifiers and ranks fail with precise field errors', async () => {
  const { book, author } = await authoredBook();
  const base = { type: 'schema:Book', labels: { en: 'Invalid book' } };
  const invalid = async (body: unknown, pointer: string, code: string) => {
    const response = await write('editor', 'POST', '/v1/subjects', body);
    field(response, pointer, code);
    expect(response.body.subject).toBeUndefined();
    expect(response.headers.get('location')).toBeNull();
  };
  await unchanged(book.id, async () => {
    await invalid({ ...base, type: 'schema:NotAType' }, '/type', 'unsupported');
    await invalid(
      {
        ...base,
        statements: {
          'schema:recipeIngredient': [statement('schema:recipeIngredient', { language: 'en', text: 'miso' })],
        },
      },
      '/statements/schema:recipeIngredient',
      'unsupported',
    );
    await invalid(
      { ...base, statements: { 'schema:author': [statement('schema:author', Bun.randomUUIDv7())] } },
      '/statements/schema:author/0/value/content',
      'out_of_range',
    );
    await invalid(
      { ...base, statements: { 'schema:author': [statement('schema:author', book.id)] } },
      '/statements/schema:author/0/value/content',
      'out_of_range',
    );
    await invalid(
      {
        ...base,
        statements: {
          'schema:author': [
            { ...statement('schema:author', author.id), qualifiers: [part('schema:isbn', '9780143106036')] },
          ],
        },
      },
      '/statements/schema:author/0/qualifiers/0/property/id',
      'unsupported',
    );
    await invalid(
      {
        ...base,
        statements: { 'schema:url': [{ ...statement('schema:url', 'https://www.aozora.gr.jp/'), rank: 'deprecated' }] },
      },
      '/statements/schema:url/0/rank',
      'unsupported',
    );
    await invalid(
      {
        type: 'bf:Instance',
        labels: { en: 'Invalid pages' },
        statements: { 'schema:numberOfPages': [statement('schema:numberOfPages', { amount: '+0', unit: '1' })] },
      },
      '/statements/schema:numberOfPages/0/value/content/amount',
      'out_of_range',
    );
    await invalid(
      {
        type: 'bf:Instance',
        labels: { en: 'Invalid pages' },
        statements: { 'schema:numberOfPages': [statement('schema:numberOfPages', { amount: '+12.5', unit: '1' })] },
      },
      '/statements/schema:numberOfPages/0/value/content/amount',
      'invalid_format',
    );
  });
});

test('Editor proposes a pending author then acceptor accepts and adopts with one authoritative revision per command', async () => {
  const { digest } = await active();
  const { book, original } = await authoredBook();
  expect(original).toMatchObject({
    id: book.statements['schema:author']![0]!.id,
    decision: 'accepted',
    head: expect.any(Number),
    rank: 'preferred',
  });
  const second = await create('schema:Organization', 'Kokoro editorial collective');
  const proposed = await propose(book.id, 'schema:author', second.id);
  expect(proposed.revision).toBe(2);
  expect((await read(book.id)).subject.statements).toEqual(book.statements);
  const pending = (await candidates(book.id, 'schema:author', driver.globalContext, second.id)).find(
    (c) => c.id === proposed.candidate,
  )!;
  expect(pending).toMatchObject({
    id: proposed.candidate,
    release: digest,
    revision: 2,
    decision: null,
    head: null,
    rank: null,
  });
  expect(pending.statement.references).toMatchObject(proposed.input.references!);
  shape(pending.statement, 'schema:author', 'wikibase-item', second.id, digest, 2);
  const token = key();
  const path = acceptancePath(book.id, proposed.candidate);
  const body = { context: driver.globalContext, expected_head: null };
  const accepted = await write('acceptor', 'POST', path, body, token);
  expect(accepted.status).toBe(200);
  expect(accepted.body.revision).toBe(3);
  expect((await read(book.id)).subject.statements).toEqual(book.statements);
  await unchanged(book.id, async () => {
    expect((await write('acceptor', 'POST', path, body, token)).body).toEqual(accepted.body);
    problem(
      await write('acceptor', 'POST', acceptancePath(book.id, proposed.candidate, 'reject'), body, token),
      422,
      'idempotency_conflict',
    );
    problem(await write('acceptor', 'POST', path, body), 409, 'stale_editorial_head');
  });
  const adoption = await write('acceptor', 'POST', adoptionPath(book.id), {
    context: driver.globalContext,
    property: 'schema:author',
    target: second.id,
    mode: 'replace',
    selection: [selection(proposed.candidate)],
    expected_head: null,
  });
  expect(adoption.status).toBe(200);
  expect(adoption.body).toMatchObject({
    revision: 4,
    adoption: {
      context: driver.globalContext,
      property: 'schema:author',
      mode: 'replace',
      selection: [selection(proposed.candidate)],
      head: expect.any(Number),
    },
  });
  const shown = (await read(book.id, undefined, 'acceptor')).subject;
  expect(shown.revision).toBe(4);
  expect(shown.statements['schema:author']).toHaveLength(2);
  expect(shown.statements['schema:author']).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: original.id, rank: 'preferred', rezics: { release: digest, revision: 1 } }),
      expect.objectContaining({ id: proposed.candidate, rank: 'normal', rezics: { release: digest, revision: 2 } }),
    ]),
  );
  const rows = await driver.inspect.revisions(book.id);
  expect(rows.map((r) => r.revision)).toEqual([1, 2, 3, 4]);
  expect(new Set(rows.map((r) => r.partition)).size).toBe(1);
  // Kernel routing stores the route in UUID bytes 10 and 11.
  const partition = Number.parseInt(book.id.replaceAll('-', '').slice(20, 24), 16) >>> 4;
  expect(rows.every((r) => r.partition === partition)).toBe(true);
  expect(new Set(rows.map((r) => r.transactionId)).size).toBe(4);
  const history = await get(`${subjectPath(book.id)}/revisions`);
  expect(history.status).toBe(200);
  expect(history.body).toEqual({
    revisions: [
      { revision: 4, kind: 'adopt', release: digest, source: null },
      { revision: 3, kind: 'accept', release: digest, source: null },
      { revision: 2, kind: 'propose', release: digest, source: null },
      { revision: 1, kind: 'create', release: digest, source: null },
    ],
    next: null,
  });
});

test('Sourced claims stay distinct through Context decisions, stale adoption recovery, and current public reads', async () => {
  const { digest } = await active();
  const { book, original } = await authoredBook();
  const sourcedAuthor = await create('schema:Organization', 'Kokoro editorial collective');
  const competingAuthor = await create('schema:Organization', 'Kokoro archive');
  const context = await community('Kokoro readers');
  await driver.grant('editor', ['subject:batch_write'], driver.globalContext);
  await driver.grant('acceptor', ['context:accept', 'context:adopt'], context);

  const externalId = `OL${randomUUID().replaceAll('-', '').toUpperCase()}W`;
  const source = (field_group: 'facts' | 'summary', external_id = externalId) => ({
    source: 'openlibrary',
    external_id,
    record_revision: '1',
    digest: 'a'.repeat(64),
    converter_revision: 'openlibrary@1',
    field_group,
  });
  const factSource = source('facts');
  const competingSource = source('facts', `${externalId}-alternate`);
  const summarySource = source('summary');
  const factReference = reference(`https://openlibrary.org/authors/${externalId}`);
  const competingReference = reference(`https://openlibrary.org/authors/${externalId}-alternate`);
  const summaryReference = reference(`https://openlibrary.org/works/${externalId}`);
  const namedAs = (name: string) => [part('wdt:P1932', name)];
  const sourcedFact = {
    ...statement('schema:author', sourcedAuthor.id),
    qualifiers: namedAs('Natsume Sōseki'),
    references: [factReference],
  };
  const competingFact = {
    ...statement('schema:author', competingAuthor.id),
    qualifiers: namedAs('Sōseki Natsume'),
    references: [competingReference],
  };
  const summaryText = 'A student leaves Tokyo and returns to a changing hometown.';
  const summaryBody = fromPlainText(summaryText);
  const summaryStatement = {
    ...statement('schema:abstract', { language: 'en', document: summaryBody }),
    references: [summaryReference],
  };
  const commands = [
    {
      op: 'propose',
      key: randomUUID(),
      source: factSource,
      subject: book.id,
      statement: sourcedFact,
    },
    {
      op: 'propose',
      key: randomUUID(),
      source: competingSource,
      subject: book.id,
      statement: competingFact,
    },
    {
      op: 'propose',
      key: randomUUID(),
      source: summarySource,
      subject: book.id,
      statement: summaryStatement,
      rights: {
        license: 'CC-BY-SA-3.0',
        obligations: ['cc:Attribution', 'cc:ShareAlike'],
        attribution: 'Open Library contributors',
      },
    },
  ];
  const batchKey = key();
  const received = await write('editor', 'POST', '/v1/subjects:batchWrite', { commands }, batchKey);
  expect(received.status).toBe(200);
  expect(received.body.results).toMatchObject([
    { key: commands[0]!.key, status: 201, value: { candidate: expect.any(String), revision: 2 } },
    { key: commands[1]!.key, status: 201, value: { candidate: expect.any(String), revision: 3 } },
    { key: commands[2]!.key, status: 201, value: { candidate: expect.any(String), revision: 4 } },
  ]);
  const sourceCandidates = received.body.results as {
    value: { candidate: string; revision: number };
  }[];
  const sourcedCandidate = sourceCandidates[0]!.value.candidate;
  const competingCandidate = sourceCandidates[1]!.value.candidate;
  const summaryCandidate = sourceCandidates[2]!.value.candidate;
  const receiptReplay = await write('editor', 'POST', '/v1/subjects:batchWrite', { commands }, batchKey);
  expect(receiptReplay.body).toEqual(received.body);

  const beforeGlobal = (await read(book.id, undefined, 'anonymous')).subject;
  const beforeContext = (await read(book.id, context, 'anonymous')).subject;
  const pendingSourced = (await candidatePage(book.id, 'schema:author', context, sourcedAuthor.id)).candidates.find(
    (candidate) => candidate.id === sourcedCandidate,
  )!;
  const pendingCompeting = (await candidatePage(book.id, 'schema:author', context, competingAuthor.id)).candidates.find(
    (candidate) => candidate.id === competingCandidate,
  )!;
  const pendingSummary = (await candidatePage(book.id, 'schema:abstract', context)).candidates.find(
    (candidate) => candidate.id === summaryCandidate,
  )!;
  expect(pendingSourced).toMatchObject({
    source: factSource,
    revision: 2,
    decision: null,
    head: null,
    rank: null,
    statement: {
      property: { id: 'schema:author' },
      value: value(sourcedAuthor.id),
      qualifiers: namedAs('Natsume Sōseki'),
      references: [{ hash: expect.any(String), parts: factReference.parts }],
      rezics: { release: digest, revision: 2 },
    },
  });
  expect(pendingCompeting).toMatchObject({
    source: competingSource,
    revision: 3,
    decision: null,
    rank: null,
    statement: {
      value: value(competingAuthor.id),
      qualifiers: namedAs('Sōseki Natsume'),
      references: [{ hash: expect.any(String), parts: competingReference.parts }],
    },
  });
  expect(pendingSummary).toMatchObject({
    source: summarySource,
    revision: 4,
    decision: null,
    rank: null,
    statement: {
      property: { id: 'schema:abstract' },
      references: [{ hash: expect.any(String), parts: summaryReference.parts }],
      rezics: { release: digest, revision: 4 },
    },
  });
  expect(pendingSummary.statement.value.content).toMatchObject({
    language: 'en',
    document: expect.any(String),
    digest: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  expect(JSON.stringify(pendingSummary)).not.toContain(summaryText);
  expect(beforeContext.statements['schema:author']).toEqual(beforeGlobal.statements['schema:author']);
  expect(beforeContext.statements['schema:abstract'] ?? []).toEqual([]);

  const docReference = pendingSummary.statement.value.content as {
    language: string;
    document: string;
    digest: string;
  };
  const decisionBody = { context, expected_head: null };
  const acceptancePath = (candidate: string, decision: 'accept' | 'reject' = 'accept') =>
    `${subjectPath(book.id)}/candidates/${candidate}:${decision}`;
  for (const [persona, status, code] of [
    ['anonymous', 401, 'authentication_required'],
    ['suspended', 401, 'invalid_credentials'],
    ['outsider', 403, 'forbidden'],
  ] as const) {
    problem(await write(persona, 'POST', acceptancePath(sourcedCandidate), decisionBody), status, code);
    problem(
      await write(persona, 'POST', adoptionPath(book.id), {
        context,
        property: 'schema:author',
        target: sourcedAuthor.id,
        mode: 'replace',
        selection: [selection(sourcedCandidate)],
        expected_head: null,
      }),
      status,
      code,
    );
  }
  const beforeDecisions = await driver.inspect.revisions(book.id);
  expect(beforeDecisions.map((row) => row.revision)).toEqual([1, 2, 3, 4]);

  const acceptanceKey = key();
  const accepted = await write('acceptor', 'POST', acceptancePath(sourcedCandidate), decisionBody, acceptanceKey);
  expect(accepted.status).toBe(200);
  expect(accepted.body.revision).toBe(5);
  expect(await write('acceptor', 'POST', acceptancePath(sourcedCandidate), decisionBody, acceptanceKey)).toMatchObject({
    body: accepted.body,
  });
  const rejected = await accept(book.id, competingCandidate, 'reject', context);
  expect(rejected.body.revision).toBe(6);
  const acceptedSummary = await accept(book.id, summaryCandidate, 'accept', context);
  expect(acceptedSummary.body.revision).toBe(7);

  const afterDecisions = await read(book.id, context, 'anonymous');
  expect(afterDecisions.subject.statements['schema:author']).toEqual(beforeContext.statements['schema:author']);
  expect(afterDecisions.subject.statements['schema:abstract'] ?? []).toEqual([]);
  expect((await candidatePage(book.id, 'schema:author', context, sourcedAuthor.id)).candidates).toContainEqual(
    expect.objectContaining({
      id: sourcedCandidate,
      source: factSource,
      decision: 'accepted',
      head: expect.any(Number),
      rank: null,
      statement: pendingSourced.statement,
    }),
  );
  expect((await candidatePage(book.id, 'schema:author', context, competingAuthor.id)).candidates).toContainEqual(
    expect.objectContaining({ id: competingCandidate, source: competingSource, decision: 'rejected', rank: null }),
  );
  expect(
    (await candidatePage(book.id, 'schema:author', driver.globalContext, sourcedAuthor.id)).candidates,
  ).toContainEqual(expect.objectContaining({ id: sourcedCandidate, decision: null, rank: null }));
  expect((await candidatePage(book.id, 'schema:abstract', context)).candidates).toContainEqual(
    expect.objectContaining({
      id: summaryCandidate,
      source: summarySource,
      decision: 'accepted',
      rank: null,
      statement: pendingSummary.statement,
    }),
  );

  const adoptionPathForBook = adoptionPath(book.id);
  const initialAdoption = {
    context,
    property: 'schema:author',
    target: sourcedAuthor.id,
    mode: 'replace',
    selection: [selection(sourcedCandidate)],
    expected_head: null,
  };
  const competingAdoption = await write('acceptor', 'POST', adoptionPathForBook, initialAdoption);
  expect(competingAdoption.status).toBe(200);
  const intendedAdoption = {
    ...initialAdoption,
    selection: [selection(sourcedCandidate, 'preferred')],
  };
  problem(await write('acceptor', 'POST', adoptionPathForBook, intendedAdoption), 409, 'stale_editorial_head');
  const currentSelection = (await read(book.id, context, 'acceptor')).subject.statements['schema:author']!.filter(
    (candidate) => candidate.value.type === 'value' && candidate.value.content === sourcedAuthor.id,
  );
  expect(currentSelection.map((candidate) => [candidate.id, candidate.rank])).toEqual([[sourcedCandidate, 'normal']]);
  const currentSlot = await candidatePage(book.id, 'schema:author', context, sourcedAuthor.id);
  expect(currentSlot.adoption).toMatchObject({ mode: 'replace', head: expect.any(Number) });
  const rebasedIntent = {
    ...intendedAdoption,
    selection: currentSelection.map((candidate) => ({ candidate: candidate.id, rank: 'preferred' as const })),
    expected_head: currentSlot.adoption!.head,
  };
  const finalAdoptionKey = key();
  const adopted = await write('acceptor', 'POST', adoptionPathForBook, rebasedIntent, finalAdoptionKey);
  expect(adopted.status).toBe(200);
  expect(adopted.body.revision).toBe(9);
  const adoptionReplay = await write('acceptor', 'POST', adoptionPathForBook, rebasedIntent, finalAdoptionKey);
  expect(adoptionReplay.body).toEqual(adopted.body);

  const summaryAdoption = await write('acceptor', 'POST', adoptionPathForBook, {
    context,
    property: 'schema:abstract',
    mode: 'replace',
    selection: [selection(summaryCandidate)],
    expected_head: null,
  });
  expect(summaryAdoption.status).toBe(200);
  expect(summaryAdoption.body.revision).toBe(10);
  const selectedAuthor = (await candidatePage(book.id, 'schema:author', context, sourcedAuthor.id)).candidates.find(
    (candidate) => candidate.id === sourcedCandidate,
  )!;
  expect(selectedAuthor).toMatchObject({
    source: factSource,
    decision: 'accepted',
    rank: 'preferred',
    statement: pendingSourced.statement,
  });
  expect((await candidatePage(book.id, 'schema:author', context, competingAuthor.id)).candidates).toContainEqual(
    expect.objectContaining({
      id: competingCandidate,
      decision: 'rejected',
      rank: null,
      statement: pendingCompeting.statement,
    }),
  );

  const current = await read(book.id, context, 'anonymous');
  const currentFact = current.subject.statements['schema:author']!.find(
    (candidate) => candidate.id === sourcedCandidate,
  )!;
  const currentSummary = current.subject.statements['schema:abstract']!.find(
    (candidate) => candidate.id === summaryCandidate,
  )!;
  expect(currentFact).toMatchObject({
    rank: 'preferred',
    value: value(sourcedAuthor.id),
    qualifiers: namedAs('Natsume Sōseki'),
    references: [{ hash: expect.any(String), parts: factReference.parts }],
    rezics: { release: digest, revision: 2 },
  });
  expect(currentFact.references).toEqual(pendingSourced.statement.references);
  expect(current.subject.statements['schema:author']).not.toContainEqual(
    expect.objectContaining({ id: competingCandidate }),
  );
  expect(currentSummary).toMatchObject({
    value: { type: 'value', content: docReference },
    references: [{ hash: expect.any(String), parts: summaryReference.parts }],
    rezics: { release: digest, revision: 4 },
  });
  expect(currentSummary.references).toEqual(pendingSummary.statement.references);
  expect(current.related[sourcedAuthor.id]?.labels.en).toBe('Kokoro editorial collective');
  expect((await read(book.id, context, 'outsider')).subject).toEqual(current.subject);

  const document = await get(`/v1/documents/${docReference.document}`, 'anonymous');
  expect(document.status).toBe(200);
  expect(document.body.document).toMatchObject({
    source: { ...summarySource, references: [summaryReference] },
    rights: {
      license: 'CC-BY-SA-3.0',
      obligations: ['cc:Attribution', 'cc:ShareAlike'],
      attribution: 'Open Library contributors',
    },
    language: 'en',
    digest: docReference.digest,
    availability: 'available',
    body: summaryBody,
  });

  const inversePath = `${subjectPath(sourcedAuthor.id)}/links?property=schema:author&context=${encodeURIComponent(context)}`;
  const inverseDeadline = performance.now() + 15_000;
  let inverse: HttpResponse | undefined;
  do {
    inverse = await get(inversePath, 'anonymous');
    expect(inverse.status).toBe(200);
    expect(inverse.body.freshness).toMatchObject({
      consistency: 'eventual',
      target_seconds: 10,
      caught_up: expect.any(Boolean),
    });
    const linked = (inverse.body.links as { subject: string; statement: string }[]).find(
      (row) => row.subject === book.id && row.statement === sourcedCandidate,
    );
    if (linked) {
      expect(inverse.body.freshness).toMatchObject({ caught_up: true });
      break;
    }
  } while (performance.now() < inverseDeadline);
  expect(inverse?.body.links).toContainEqual(
    expect.objectContaining({ subject: book.id, property: 'schema:author', statement: sourcedCandidate }),
  );
  const relationPage = await get(
    `${subjectPath(book.id)}/relations?property=schema%3Aauthor&context=${encodeURIComponent(context)}&language=en`,
    'anonymous',
  );
  expect(relationPage.status).toBe(200);
  expect(relationPage.body.freshness).toMatchObject({ consistency: 'eventual', target_seconds: 10, caught_up: true });
  expect(relationPage.body.relations).toContainEqual(
    expect.objectContaining({ statement: currentFact, target: sourcedAuthor.id }),
  );

  const globalAfter = (await read(book.id, undefined, 'anonymous')).subject;
  expect(globalAfter.statements).toEqual(beforeGlobal.statements);
  const history = await get(`${subjectPath(book.id)}/revisions`, 'anonymous');
  expect(history.status).toBe(200);
  expect(
    (history.body.revisions as { revision: number; kind: string; source: unknown }[]).map((row) => [
      row.revision,
      row.kind,
      row.source,
    ]),
  ).toEqual([
    [10, 'adopt', null],
    [9, 'adopt', null],
    [8, 'adopt', null],
    [7, 'accept', null],
    [6, 'reject', null],
    [5, 'accept', null],
    [4, 'propose', summarySource],
    [3, 'propose', competingSource],
    [2, 'propose', factSource],
    [1, 'create', null],
  ]);
  const revisions = await driver.inspect.revisions(book.id);
  expect(revisions.map((row) => row.revision)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(new Set(revisions.map((row) => row.partition)).size).toBe(1);
  expect(new Set(revisions.map((row) => row.transactionId)).size).toBe(10);
});

test('Rejected date candidates remain deprecated and relation adoptions stay within their target slots', async () => {
  const { digest } = await active();
  const work = await create('schema:Book', 'Kokoro');
  const otherWork = await create('schema:Book', 'Botchan');
  const edition = await create('bf:Instance', 'Kokoro, Penguin Classics', {
    'schema:exampleOfWork': [statement('schema:exampleOfWork', work.id)],
    'schema:datePublished': [
      {
        ...statement('schema:datePublished', time('2010-02-23')),
        references: [reference('https://books.google.com/books?vid=ISBN9780143106036')],
      },
    ],
  });
  const proposed = await propose(edition.id, 'schema:datePublished', time('1914-09-20'));
  await accept(edition.id, proposed.candidate, 'reject');
  const shown = (await read(edition.id)).subject.statements['schema:datePublished']!;
  expect(shown).toHaveLength(2);
  expect(shown.find((s) => s.id === proposed.candidate)).toMatchObject({
    rank: 'deprecated',
    value: proposed.input.value,
    references: [{ hash: expect.any(String), parts: proposed.input.references![0]!.parts }],
    rezics: { release: digest, revision: 2 },
  });
  const dateHead = (await candidates(edition.id, 'schema:datePublished')).find(
    (c) => c.id !== proposed.candidate,
  )!.head;
  const original = (await candidates(edition.id, 'schema:exampleOfWork'))[0]!;
  const alternative = await propose(edition.id, 'schema:exampleOfWork', otherWork.id);
  await unchanged(edition.id, async () => {
    problem(
      await write('acceptor', 'POST', adoptionPath(edition.id), {
        context: driver.globalContext,
        property: 'schema:datePublished',
        mode: 'replace',
        selection: [selection(proposed.candidate)],
        expected_head: dateHead,
      }),
      409,
      'conflict',
    );
    problem(
      await write('acceptor', 'POST', adoptionPath(edition.id), {
        context: driver.globalContext,
        property: 'schema:exampleOfWork',
        mode: 'replace',
        selection: [selection(alternative.candidate)],
        expected_head: null,
      }),
      409,
      'conflict',
    );
  });
  await accept(edition.id, alternative.candidate);
  const secondSlot = await write('acceptor', 'POST', adoptionPath(edition.id), {
    context: driver.globalContext,
    property: 'schema:exampleOfWork',
    target: otherWork.id,
    mode: 'replace',
    selection: [selection(alternative.candidate)],
    expected_head: null,
  });
  expect(secondSlot.status).toBe(200);
  expect((await read(edition.id, undefined, 'acceptor')).subject.statements['schema:exampleOfWork']).toHaveLength(2);
  await unchanged(edition.id, async () => {
    field(
      await write('acceptor', 'POST', adoptionPath(edition.id), {
        context: driver.globalContext,
        property: 'schema:exampleOfWork',
        mode: 'replace',
        target: work.id,
        selection: [selection(original.id), selection(alternative.candidate)],
        expected_head: null,
      }),
      '/selection/1/candidate',
      'unsupported',
    );
  });
});

test('Concurrent adoptions with one expected head commit exactly once and replay the winning receipt', async () => {
  const { book, original } = await authoredBook();
  const before = await driver.inspect.revisions(book.id);
  const path = adoptionPath(book.id);
  const first = {
    context: driver.globalContext,
    property: 'schema:author',
    mode: 'replace',
    selection: [selection(original.id, 'preferred')],
    expected_head: original.head,
  };
  const second = { ...first, selection: [selection(original.id)] };
  const keys = [key(), key()];
  const results = await Promise.all([
    write('acceptor', 'POST', path, first, keys[0]),
    write('acceptor', 'POST', path, second, keys[1]),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  problem(
    results.find((r) => r.status === 409)!,
    409,
    'stale_editorial_head',
  );
  const rows = await driver.inspect.revisions(book.id);
  expect(rows.slice(0, -1)).toEqual(before);
  expect(rows.at(-1)!.revision).toBe(2);
  const winner = results.findIndex((r) => r.status === 200);
  await unchanged(book.id, async () => {
    const replay = await write('acceptor', 'POST', path, winner === 0 ? first : second, keys[winner]);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(results[winner]!.body);
    problem(
      await write('acceptor', 'POST', path, winner === 0 ? second : first, keys[winner]),
      422,
      'idempotency_conflict',
    );
  });
});

test('Community decisions override Global and suppression inheritance replacement and Context grants govern reads', async () => {
  const { book, original } = await authoredBook();
  const global = await get(`/v1/contexts/${driver.globalContext}`);
  expect(global.status).toBe(200);
  expect(global.body.context).toMatchObject({ id: driver.globalContext, kind: 'global' });
  const context = await community();
  await driver.grant('acceptor', ['context:accept', 'context:adopt'], context);
  expect((await read(book.id, context)).subject.statements).toEqual(book.statements);
  const rejected = await accept(book.id, original.id, 'reject', context);
  expect((await candidates(book.id, 'schema:author', context))[0]).toMatchObject({
    decision: 'rejected',
    head: expect.any(Number),
  });
  expect((await read(book.id, context)).subject.statements['schema:author'] ?? []).toEqual([]);
  expect((await read(book.id)).subject.statements).toEqual(book.statements);
  const suppress = await write('acceptor', 'POST', adoptionPath(book.id), {
    context,
    property: 'schema:author',
    mode: 'suppress',
    selection: [],
    expected_head: null,
  });
  expect(suppress.status).toBe(200);
  const suppressed = (await read(book.id, context)).subject;
  expect(suppressed.statements['schema:author'] ?? []).toEqual([]);
  expect(suppressed.resolution).toEqual({ 'schema:author': 'suppressed' });
  // Inheritance still honors this Context's rejection. Accept locally before
  // restoring the full Global result, so the two rules do not contradict.
  const local = await write('acceptor', 'POST', acceptancePath(book.id, original.id), {
    context,
    expected_head: (rejected.body.acceptance as { head: number }).head,
  });
  expect(local.status).toBe(200);
  const inherited = await write('acceptor', 'POST', adoptionPath(book.id), {
    context,
    property: 'schema:author',
    mode: 'inherit',
    selection: [],
    expected_head: (suppress.body.adoption as { head: number }).head,
  });
  expect(inherited.status).toBe(200);
  const restored = (await read(book.id, context)).subject;
  expect(restored.statements).toEqual(book.statements);
  expect(restored.resolution).toEqual({});
  const replace = await write('acceptor', 'POST', adoptionPath(book.id), {
    context,
    property: 'schema:author',
    mode: 'replace',
    selection: [selection(original.id)],
    expected_head: (inherited.body.adoption as { head: number }).head,
  });
  expect(replace.status).toBe(200);
  expect((await read(book.id, context)).subject.statements['schema:author']).toMatchObject([
    { id: original.id, rank: 'normal' },
  ]);
  expect((await read(book.id)).subject.statements).toEqual(book.statements);
  const other = await community('Another community');
  await unchanged(book.id, async () => {
    problem(
      await write('acceptor', 'POST', acceptancePath(book.id, original.id), { context: other, expected_head: null }),
      403,
      'forbidden',
    );
    problem(
      await write('acceptor', 'POST', adoptionPath(book.id), {
        context: other,
        property: 'schema:author',
        mode: 'suppress',
        selection: [],
        expected_head: null,
      }),
      403,
      'forbidden',
    );
    field(
      await write('acceptor', 'POST', adoptionPath(book.id), {
        context: driver.globalContext,
        property: 'schema:author',
        mode: 'inherit',
        selection: [],
        expected_head: original.head,
      }),
      '/mode',
      'unsupported',
    );
  });
});

test('Persona denials and invalid proposals append no revisions and leave public reads unchanged', async () => {
  const { author, book, original } = await authoredBook();
  const other = await create('schema:Book', 'Botchan');
  await unchanged(book.id, async () => {
    const proposePath = `${subjectPath(book.id)}/candidates`;
    const proposal = { statement: { ...statement('schema:author', author.id), references: [reference()] } };
    field(
      await write('editor', 'POST', proposePath, { statement: statement('schema:author', author.id) }),
      '/statement/references',
      'required',
    );
    field(
      await write('editor', 'POST', proposePath, { statement: { ...proposal.statement, references: [] } }),
      '/statement/references',
      'required',
    );
    for (const [persona, status, code] of [
      ['editor', 403, 'forbidden'],
      ['anonymous', 401, 'authentication_required'],
      ['suspended', 401, 'invalid_credentials'],
    ] as const) {
      problem(
        await write(persona, 'POST', acceptancePath(book.id, original.id), {
          context: driver.globalContext,
          expected_head: original.head,
        }),
        status,
        code,
      );
      problem(
        await write(persona, 'POST', adoptionPath(book.id), {
          context: driver.globalContext,
          property: 'schema:author',
          mode: 'replace',
          selection: [],
          expected_head: original.head,
        }),
        status,
        code,
      );
      problem(
        await write(persona, 'POST', mergePath, { subjects: [book.id, other.id] }),
        persona === 'anonymous' ? 403 : status,
        persona === 'anonymous' ? 'platform_closed' : code,
      );
      if (persona !== 'editor') {
        problem(
          await write(persona, 'POST', '/v1/subjects', { type: 'schema:Book', labels: { en: 'Denied' } }),
          status,
          code,
        );
        problem(await write(persona, 'POST', proposePath, proposal), status, code);
        problem(await write(persona, 'POST', '/v1/contexts', { labels: { en: 'Denied' } }), status, code);
      }
    }
  });
  for (const persona of ['steward', 'acceptor'] as const) {
    const created = await write(persona, 'POST', '/v1/subjects', {
      type: 'schema:Book',
      labels: { en: 'Standing grant' },
    });
    expect(created.status).toBe(201);
    const subject = created.body.subject as Subject;
    const path = `${subjectPath(subject.id)}/candidates`;
    const proposal = { statement: { ...statement('schema:author', author.id), references: [reference()] } };
    expect((await write(persona, 'POST', path, proposal)).status).toBe(201);
    problem(
      await write('suspended', 'POST', '/v1/subjects', { type: 'schema:Book', labels: { en: 'Denied' } }),
      401,
      'invalid_credentials',
    );
    problem(await write('suspended', 'POST', path, proposal), 401, 'invalid_credentials');
  }
  expect(await driver.inspect.revisions(other.id)).toHaveLength(1);
  for (const path of [
    '/v1/definitions/active',
    `/v1/definitions/releases/${(await active()).digest}`,
    subjectPath(book.id),
    `${subjectPath(book.id)}/revisions`,
    `${subjectPath(book.id)}/candidates?property=schema:author`,
    `${subjectPath(book.id)}/links`,
    `/v1/contexts/${driver.globalContext}`,
  ]) {
    problem(await get(path, 'suspended'), 401, 'invalid_credentials', false);
  }
  for (const persona of ['editor', 'acceptor', 'steward'] as const) {
    expect((await get(subjectPath(book.id), persona)).body).toEqual((await get(subjectPath(book.id))).body);
  }
});

interface Link {
  subject: string;
  property: string;
  statement: string;
  assertion?: Statement;
  related?: Record<string, unknown>;
  type: string;
  label: string;
  summary: {
    id: string;
    type: string;
    types: string[];
    label: { value: string; language: string };
    creativeWork: boolean;
    cover: null;
  };
}
const instanceSummary = (id: string, label: string): Link['summary'] => ({
  id,
  type: 'bf:Instance',
  types: ['bf:Instance', 'schema:CreativeWork', 'schema:Thing'],
  label: { value: label, language: 'en' },
  creativeWork: true,
  cover: null,
});
async function links(id: string, persona: Persona) {
  const response = await get(
    `${subjectPath(id)}/links?property=${encodeURIComponent('schema:exampleOfWork')}`,
    persona,
  );
  expect(response.status).toBe(200);
  expect(response.body.next).toBeNull();
  expect(response.body.freshness).toMatchObject({
    consistency: 'eventual',
    target_seconds: 10,
    caught_up: expect.any(Boolean),
  });
  return response.body as { links: Link[]; freshness: { caught_up: boolean } };
}
async function eventuallyLink(work: string, expected: Link, persona: Persona) {
  const deadline = performance.now() + 15_000;
  do {
    // Poll actual HTTP without fixed sleeps or a simulated projection drain.
    const result = await links(work, persona);
    const current = result.links.find((link) => link.statement === expected.statement);
    if (current) {
      expect(performance.now()).toBeLessThanOrEqual(deadline);
      expect(current).toMatchObject(expected);
      expect(current.assertion).toMatchObject({
        id: expected.statement,
        property: { id: expected.property },
        value: { type: 'value', content: work },
      });
      expect(current.related).toMatchObject({ [work]: { id: work } });
      return result;
    }
  } while (performance.now() < deadline);
  throw new Error('Incoming link did not appear within 15 seconds');
}

test('Incoming links honor the editor session and become visible anonymously within fifteen seconds', async () => {
  const work = await create('schema:Book', 'Kokoro');
  const edition = await create('bf:Instance', 'Kokoro, Penguin Classics', {
    'schema:exampleOfWork': [statement('schema:exampleOfWork', work.id)],
    'schema:isbn': [statement('schema:isbn', '9780143106036')],
  });
  const expected = {
    subject: edition.id,
    property: 'schema:exampleOfWork',
    statement: edition.statements['schema:exampleOfWork']![0]!.id,
    type: 'bf:Instance',
    label: 'Kokoro, Penguin Classics',
    summary: instanceSummary(edition.id, 'Kokoro, Penguin Classics'),
  };
  const own = await links(work.id, 'editor');
  const current = own.links.find((link) => link.statement === expected.statement);
  expect(current).toBeDefined();
  expect(current).toMatchObject(expected);
  expect(current!.assertion).toMatchObject({
    id: expected.statement,
    property: { id: 'schema:exampleOfWork' },
    value: { type: 'value', content: work.id },
  });
  expect(current!.related).toMatchObject({ [work.id]: { id: work.id } });
  expect(own.freshness.caught_up).toBe(true);
  await eventuallyLink(work.id, expected, 'anonymous');
});

test('Paused projection answers the editor within three seconds with stale links and catches up after resuming', async () => {
  const work = await create('schema:Book', 'Kokoro');
  await driver.projection('paused');
  try {
    const edition = await create('bf:Instance', 'Kokoro, another edition', {
      'schema:exampleOfWork': [statement('schema:exampleOfWork', work.id)],
      'schema:isbn': [statement('schema:isbn', '9780804813286')],
    });
    const expected = {
      subject: edition.id,
      property: 'schema:exampleOfWork',
      statement: edition.statements['schema:exampleOfWork']![0]!.id,
      type: 'bf:Instance',
      label: 'Kokoro, another edition',
      summary: instanceSummary(edition.id, 'Kokoro, another edition'),
    };
    const started = performance.now();
    const stale = await links(work.id, 'editor');
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(stale.links).not.toContainEqual(expect.objectContaining({ statement: expected.statement }));
    expect(stale.freshness.caught_up).toBe(false);
    await driver.projection('running');
    expect((await eventuallyLink(work.id, expected, 'editor')).freshness.caught_up).toBe(true);
  } finally {
    await driver.projection('running');
  }
});

test('Acceptor merges persons by smallest UUID with redirects related labels and one redirected-subject revision', async () => {
  const { digest } = await active();
  const first = await create('schema:Person', 'Natsume Sōseki');
  const second = await create('schema:Person', 'Sōseki Natsume');
  const bookA = await create('schema:Book', 'Kokoro', { 'schema:author': [statement('schema:author', first.id)] });
  const bookB = await create('schema:Book', 'Botchan', { 'schema:author': [statement('schema:author', second.id)] });
  const [survivor, redirected] = [first, second].sort((a, b) => a.id.localeCompare(b.id));
  const survivorBefore = await driver.inspect.revisions(survivor!.id);
  const redirectedBefore = await driver.inspect.revisions(redirected!.id);
  const token = key();
  const body = { subjects: [second.id, first.id] };
  const merged = await write('acceptor', 'POST', mergePath, body, token);
  expect(merged.status).toBe(202);
  expect(merged.body).toEqual({ operation: { id: expect.any(String) } });
  const operationId = (merged.body.operation as { id: string }).id;
  expect(merged.headers.get('location')).toBe(`/v1/subjectIdentityOperations/${operationId}`);
  const operation = await get(`/v1/subjectIdentityOperations/${operationId}`, 'acceptor');
  expect(operation.status).toBe(200);
  expect(operation.body).toEqual({ operation: { id: operationId, done: false } });
  const redirect = await get(subjectPath(redirected!.id));
  expect(redirect.status).toBe(308);
  expect(redirect.body).toEqual({ redirect: { from: redirected!.id, to: survivor!.id } });
  const terminalPath = redirect.headers.get('location');
  expect(terminalPath).toBe(subjectPath(survivor!.id));
  const terminal = await get(terminalPath!, 'anonymous');
  expect(terminal.status).toBe(200);
  expect(terminal.body.subject).toMatchObject({ id: survivor!.id, labels: survivor!.labels });
  const book = redirected!.id === first.id ? bookA : bookB;
  const result = await read(book.id);
  expect(result.related[redirected!.id]).toEqual({
    redirect: survivor!.id,
    labels: survivor!.labels,
    type: 'schema:Person',
    types: ['schema:Person', 'schema:Thing'],
    cover: null,
  });
  expect(result.subject.statements).toEqual(book.statements);
  expect(await driver.inspect.revisions(survivor!.id)).toEqual(survivorBefore);
  const rows = await driver.inspect.revisions(redirected!.id);
  expect(rows.slice(0, -1)).toEqual(redirectedBefore);
  expect(rows.map((r) => r.revision)).toEqual([1, 2]);
  expect(rows[1]!.partition).toBe(rows[0]!.partition);
  expect(rows[1]!.transactionId).not.toBe(rows[0]!.transactionId);
  const history = await get(`${subjectPath(redirected!.id)}/revisions`);
  expect(history.status).toBe(200);
  expect(history.body).toEqual({
    revisions: [
      { revision: 2, kind: 'merge', release: digest, source: null },
      { revision: 1, kind: 'create', release: digest, source: null },
    ],
    next: null,
  });
  const replay = await write('acceptor', 'POST', mergePath, body, token);
  expect(replay.status).toBe(202);
  expect(replay.body).toEqual(merged.body);
  problem(
    await write('editor', 'POST', `${subjectPath(redirected!.id)}/candidates`, {
      statement: { ...statement('schema:url', 'https://www.aozora.gr.jp/'), references: [reference()] },
    }),
    409,
    'conflict',
  );
  problem(await write('acceptor', 'POST', mergePath, body), 409, 'conflict');
  problem(await write('acceptor', 'POST', mergePath, { subjects: [survivor!.id, survivor!.id] }), 409, 'conflict');
  const third = await create('schema:Person', 'Natsume Kinnosuke');
  problem(await write('acceptor', 'POST', mergePath, { subjects: [redirected!.id, third.id] }), 409, 'conflict');
  problem(await write('acceptor', 'POST', mergePath, { subjects: [survivor!.id, bookA.id] }), 409, 'conflict');
  expect(await driver.inspect.revisions(redirected!.id)).toEqual(rows);
  expect(await driver.inspect.revisions(survivor!.id)).toEqual(survivorBefore);
  for (const untouched of [bookA, bookB, third]) expect(await driver.inspect.revisions(untouched.id)).toHaveLength(1);
});

test('Unknown and malformed subject identifiers are indistinguishable for every persona allowed to read', async () => {
  for (const persona of ['anonymous', 'editor', 'acceptor', 'steward'] as const) {
    const missing = await get(subjectPath(Bun.randomUUIDv7()), persona);
    const malformed = await get(subjectPath('not-an-id'), persona);
    problem(missing, 404, 'not_found', false);
    problem(malformed, 404, 'not_found', false);
    const { request_id: _first, ...a } = missing.body;
    const { request_id: _second, ...b } = malformed.body;
    expect(a).toEqual(b);
    expect(missing.headers.get('rezics-session-token')).toBeNull();
    expect(malformed.headers.get('rezics-session-token')).toBeNull();
  }
});
