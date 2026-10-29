import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { releaseDigest, validateRelease, valueSchema, type Release } from '@rezics/definitions';
import { bundledRelease } from '@rezics/definitions/bundled';
import { admitFilter, parseFilter } from '@rezics/filter';
import { createKernel } from '../../src/http/kernel.ts';
import { newId } from '../../src/route/route.ts';
import { activeRelease, bootstrapRelease, GLOBAL_CONTEXT, readRelease } from '../../src/semantic/definitions.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { subjectPartition } from '../../src/search/source.ts';
import { openGrowthDatabase } from '../support/growth.ts';
import { createRealAccess } from './real-access.ts';

export const digestA = `sha256:${'a'.repeat(64)}`;
export const digestB = `sha256:${'b'.repeat(64)}`;
export const freeText = ` é=e\u0301 ${'x'.repeat(130)}`;
export const snak = (id: string, content: unknown) => ({ property: { id }, value: { type: 'value', content } });
export const reading = (language: string, digest: string, method: string, text = freeText) => ({
  ...snak('ex:reading', 'A1'),
  qualifiers: [
    snak('ex:language', language),
    snak('ex:digest', digest),
    snak('ex:method', method),
    snak('ex:text', text),
  ],
});

// Generic primitive conformance only: no bundled Word/form/diet/measurement data is replaced or claimed.
export async function stringQualifierFixture() {
  const db = await openGrowthDatabase();
  const actions = [
    'subject:create',
    'subject:read',
    'statement:propose',
    'context:accept',
    'context:adopt',
    'moderation:hide',
    'definitions:publish',
    'definitions:activate',
  ];
  const real = await createRealAccess(db.admin, { editor: newId(31001) }, actions);
  for (const action of actions) await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  const release: Release = structuredClone(bundledRelease);
  release.catalogue = { id: 'https://example.test/string-qualifier', version: '1' };
  release.prefixes.ex = 'https://example.test/string-qualifier/';
  release.filters = {};
  release.types['ex:Sample'] = {
    iri: `${release.prefixes.ex}Sample`,
    labels: { en: 'Primitive sample' },
    mappings: [],
    bases: [],
    properties: ['ex:reading'],
    facets: ['ex:reading'],
  };
  const property = (name: string, datatype: 'string' | 'wikibase-item', pattern?: string) => ({
    iri: `${release.prefixes.ex}${name}`,
    labels: { en: name },
    mappings: [],
    datatype,
    multivalued: true,
    qualifiers: [],
    value: valueSchema(datatype, pattern === undefined ? {} : { pattern }),
    ...(datatype === 'wikibase-item' ? { targets: ['skos:Concept'] } : {}),
  });
  release.properties['ex:reading'] = {
    ...property('reading', 'string', '^[A-Z][0-9]$'),
    qualifiers: ['ex:digest', 'ex:language', 'ex:method', 'ex:text'],
  };
  release.properties['ex:language'] = {
    ...structuredClone(release.properties['schema:inLanguage']!),
    iri: `${release.prefixes.ex}language`,
    labels: { en: 'Language' },
  };
  release.properties['ex:digest'] = property('digest', 'string', '^sha256:[0-9a-f]{64}$');
  release.properties['ex:method'] = property('method', 'wikibase-item');
  release.properties['ex:text'] = property('text', 'string');
  expect(validateRelease(release)).toEqual([]);
  await bootstrapRelease(db.pool, release);
  const routeKey = new Uint8Array(32).fill(83);
  const kernel = createKernel({ pool: db.pool, routeKey, access: real.access, writeRate: real.writeRate });
  let session: string | null = null;
  async function call(path: string, body: unknown, method = 'POST') {
    const response = await kernel.handle(
      new Request(`http://kernel.test${path}`, {
        method,
        headers: {
          authorization: `Bearer ${real.bearer('editor')}`,
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(randomUUID()),
          ...(session ? { 'rezics-session-token': session } : {}),
        },
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      }),
    );
    session = response.headers.get('rezics-session-token') ?? session;
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  }
  async function post(path: string, body: unknown, status = 200) {
    const result = await call(path, body);
    expect([result.status, result.body.code], `${path}: ${JSON.stringify(result.body)}`).toEqual([status, undefined]);
    return result.body;
  }
  async function activate(next: Release) {
    const digest = releaseDigest(next);
    if ((await activeRelease(db.pool))?.digest === digest) return;
    await post('/v1/definitions/releases', { release: next }, (await readRelease(db.pool, digest)) ? 200 : 201);
    await post(`/v1/definitions/releases/${digest}:activate`, {
      expected_head: (await activeRelease(db.pool))?.head ?? null,
    });
  }
  await activate(release);
  async function create(statements: unknown[] = [], type = 'ex:Sample') {
    return (
      await post(
        '/v1/subjects',
        {
          type,
          labels: { en: 'Native string qualifier' },
          ...(statements.length ? { statements: { 'ex:reading': statements } } : {}),
        },
        201,
      )
    ).subject;
  }
  async function adopt(subject: string, statement: unknown) {
    const candidate = (
      await post(
        `/v1/subjects/${subject}/candidates`,
        {
          statement: {
            ...(statement as object),
            references: [{ parts: [snak('schema:url', 'https://example.test/evidence')] }],
          },
        },
        201,
      )
    ).candidate as string;
    await post(`/v1/subjects/${subject}/candidates/${candidate}:accept`, {
      context: GLOBAL_CONTEXT,
      expected_head: null,
    });
    const current = await call(`/v1/subjects/${subject}/candidates?property=ex%3Areading`, undefined, 'GET');
    expect([current.status, current.body.code]).toEqual([200, undefined]);
    await post(`/v1/subjects/${subject}:adopt`, {
      context: GLOBAL_CONTEXT,
      property: 'ex:reading',
      mode: 'replace',
      selection: [{ candidate, rank: 'preferred' }],
      expected_head: current.body.adoption?.head ?? null,
    });
    return candidate;
  }
  const source = subjectSource(db.pool, routeKey);
  const read = async (id: string) => source.read(subjectPartition(id), [id]);
  return { db, release, source, create, adopt, post, call, activate, read, close: () => db.close() };
}

test('generic typed string qualifier equality admits every declared string under existing scalar constraints and preserves same statement native source values losslessly', async () => {
  const f = await stringQualifierFixture();
  try {
    const methodA = (await f.create([], 'skos:Concept')).id as string;
    const methodB = (await f.create([], 'skos:Concept')).id as string;
    const query = {
      statement: {
        property: 'ex:reading',
        in: ['A1'],
        qualifiers: [
          { property: 'ex:language', in: ['en', 'ja'] },
          { property: 'ex:digest', in: [digestA, digestB] },
          { property: 'ex:method', in: [methodA, methodB] },
          { property: 'ex:text', in: [freeText] },
        ],
      },
    };
    expect(admitFilter(parseFilter(query), f.release)).toEqual(query);
    const subject = await f.create([reading('en', digestA, methodA), reading('ja', digestB, methodB)]);
    const expected = (language: string, digest: string, method: string) => ({
      property: 'ex:reading',
      value: 'A1',
      facet: { kind: 'code' as const },
      qualifiers: [
        { property: 'ex:language', value: language },
        { property: 'ex:digest', value: digest },
        { property: 'ex:method', value: method },
        { property: 'ex:text', value: freeText },
      ],
    });
    expect((await f.read(subject.id)).subjects[0]!.statements).toEqual([
      expected('en', digestA, methodA),
      expected('ja', digestB, methodB),
    ]);
    const candidate = await f.adopt(subject.id, reading('zh-Hant', digestB, methodB));
    expect((await f.read(subject.id)).subjects[0]!.statements).toEqual([expected('zh-Hant', digestB, methodB)]);
    // The active release changes the qualifier datatype; extraction still uses each row's immutable release.
    const next = structuredClone(f.release);
    next.catalogue.version = '2';
    next.properties['ex:text'] = {
      ...next.properties['ex:text']!,
      datatype: 'monolingualtext',
      value: valueSchema('monolingualtext'),
    };
    await f.activate(next);
    expect((await f.read(subject.id)).subjects[0]!.statements).toEqual([expected('zh-Hant', digestB, methodB)]);
    await f.post(`/v1/subjects/${subject.id}/candidates/${candidate}:hide`, { reason: 'Withheld native evidence' });
    expect((await f.read(subject.id)).subjects[0]!.statements).toEqual([]);
  } finally {
    await f.close();
  }
});

test('native unknown and missing qualifier representations cannot certify complete absence', async () => {
  const f = await stringQualifierFixture();
  try {
    for (const property of ['ex:language', 'ex:digest', 'ex:method']) {
      const subject = await f.create([
        { ...snak('ex:reading', 'A1'), qualifiers: [{ property: { id: property }, value: { type: 'somevalue' } }] },
      ]);
      // Actual legacy ABI drops unknown snaks. This is an observed limitation, never a false proof under NOT.
      expect((await f.read(subject.id)).subjects[0]!.statements).toEqual([
        { property: 'ex:reading', value: 'A1', facet: { kind: 'code' } },
      ]);
    }
    const missing = await f.create([snak('ex:reading', 'A1')]);
    expect((await f.read(missing.id)).subjects[0]!.statements[0]!.qualifiers).toBeUndefined();
  } finally {
    await f.close();
  }
});
