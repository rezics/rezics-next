import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PROFILE_FORMAT, type PresentationProfile } from '@rezics/composition';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapProfile } from '../../src/presentation/profiles.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createRealAccess } from './real-access.ts';

let db: GrowthDatabase;
let app: ReturnType<typeof createKernel>;
let real: Awaited<ReturnType<typeof createRealAccess<{ editor: string }>>>;
const editor = '019a1b2c-3d4e-7f00-8a00-ed170e000265';
const routeKey = new Uint8Array(32).fill(114);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(115)]]) };
const actions = [
  'subject:create',
  'subject:read',
  'statement:propose',
  'context:accept',
  'context:adopt',
  'moderation:hide',
  'presentation:read',
];
const value = (content: unknown) => ({ type: 'value', content });
const qualifier = (property: string, content: unknown) => ({ property: { id: property }, value: value(content) });
const source = { parts: [qualifier('schema:url', 'https://source.example.test/anidb/file')] };
const fact = (property: string, content: unknown, qualifiers: unknown[] = []) => ({
  property: { id: property },
  value: value(content),
  qualifiers,
  references: [source],
});
const profile: PresentationProfile = {
  format: PROFILE_FORMAT,
  generic: {
    views: {
      overview: {
        root: { props: {} },
        content: [
          { type: 'SubjectHeader', props: { id: 'header' } },
          { type: 'Statements', props: { id: 'file-facts', properties: ['wdt:P4092', 'wdt:P3575', 'rezics:codec'] } },
          { type: 'RelationGroups', props: { id: 'episode', property: 'schema:encodesCreativeWork', limit: 20 } },
        ],
      },
    },
  },
  bases: [],
  types: [],
  routes: [],
};

beforeAll(async () => {
  db = await openGrowthDatabase();
  await bootstrapRelease(db.pool, bundledRelease);
  await bootstrapProfile(db.pool, profile);
  real = await createRealAccess(db.admin, { editor }, actions);
  await db.admin.query("UPDATE access.account SET rate_tier='trusted' WHERE route=$1 AND account_id=$2", [
    routeOf(editor),
    editor,
  ]);
  for (const action of actions) await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  app = createKernel({ pool: db.pool, routeKey, tokens, access: real.access, writeRate: real.writeRate });
}, 60_000);
afterAll(async () => {
  if (db) await db.close();
});

async function send(method: string, path: string, body?: unknown, authenticated = true, key?: string) {
  const headers: Record<string, string> = {};
  if (authenticated) headers.authorization = `Bearer ${real.bearer('editor')}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (key !== undefined) headers['idempotency-key'] = key;
  else if (body !== undefined && !path.endsWith('/v1/pages:read')) headers['idempotency-key'] = `"${randomUUID()}"`;
  const response = await app.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { response, body: (await response.json()) as Record<string, any> };
}
async function write(path: string, body: unknown, expected = 200) {
  const key = `"${randomUUID()}"`;
  let result = await send('POST', path, body, true, key);
  for (
    let retry = 0;
    retry < 2 &&
    result.response.status === 503 &&
    result.body.code === 'overloaded' &&
    result.body.retryable === true &&
    result.body.effect_status === 'not_applied';
    retry++
  )
    result = await send('POST', path, body, true, key);
  expect([path, result.response.status, result.response.status === expected ? null : result.body]).toEqual([
    path,
    expected,
    null,
  ]);
  return result.body;
}
async function subject(type: string, label: string, statements: Record<string, unknown[]> = {}) {
  return (await write('/v1/subjects', { type, labels: { en: label }, statements }, 201)).subject as {
    id: string;
    type: string;
    statements: Record<string, { id: string }[]>;
  };
}

test('native file identity, sourced correction, group disclosure and page actions follow current released types', async () => {
  const group = await subject('rezics:ReleaseGroup', 'Source group');
  const episode = await subject('schema:Episode', 'Episode 1');
  const hash = 'f'.repeat(512);
  const fileFacts = (algorithm: string, codec: string) => ({
    'wdt:P4092': [fact('wdt:P4092', hash, [qualifier('rezics:hashAlgorithm', algorithm)])],
    'wdt:P3575': [fact('wdt:P3575', { amount: '+123456789', unit: 'wd:Q8799' })],
    'rezics:codec': [fact('rezics:codec', codec)],
    'rezics:fileQuality': [fact('rezics:fileQuality', '1080p')],
    'schema:inLanguage': [fact('schema:inLanguage', 'ja')],
    'rezics:releaseGroup': [fact('rezics:releaseGroup', group.id)],
    'schema:encodesCreativeWork': [fact('schema:encodesCreativeWork', episode.id)],
  });
  const first = await subject('schema:MediaObject', 'Episode file A', fileFacts('sha256', 'h264'));
  const second = await subject('schema:MediaObject', 'Episode file B', fileFacts('future-v9', 'av1'));
  const edition = await subject('rezics:AnimeRelease', 'Published edition', {
    'schema:associatedMedia': [fact('schema:associatedMedia', first.id)],
  });
  expect(new Set([first.id, second.id, edition.id, group.id, episode.id]).size).toBe(5);

  const candidate = (
    await write(
      `/v1/subjects/${first.id}/candidates`,
      {
        statement: fact('wdt:P4092', 'corrected-' + hash, [qualifier('rezics:hashAlgorithm', 'sha256')]),
      },
      201,
    )
  ).candidate as string;
  await write(`/v1/subjects/${first.id}/candidates/${candidate}:accept`, {
    context: GLOBAL_CONTEXT,
    expected_head: null,
  });
  await write(`/v1/subjects/${first.id}:adopt`, {
    context: GLOBAL_CONTEXT,
    property: 'wdt:P4092',
    mode: 'replace',
    selection: [{ candidate, rank: 'normal' }],
    expected_head: null,
  });
  const factual = await send('GET', `/v1/subjects/${first.id}`, undefined, false);
  expect(factual.response.status).toBe(200);
  const adopted = factual.body.subject.statements['wdt:P4092'][0];
  expect(adopted.value.content).toBe('corrected-' + hash);
  expect(adopted.qualifiers[0]).toMatchObject({ property: { id: 'rezics:hashAlgorithm' }, value: value('sha256') });
  expect(factual.body.subject.statements['rezics:releaseGroup'][0].value.content).toBe(group.id);
  expect(factual.body.subject.statements['schema:encodesCreativeWork'][0].value.content).toBe(episode.id);
  expect(factual.body.subject.type).toBe('schema:MediaObject');
  expect(factual.body.subject.statements['rezics:copy']).toBeUndefined();

  const wrongUnit = await send('POST', '/v1/subjects', {
    type: 'schema:MediaObject',
    labels: { en: 'Wrong unit' },
    statements: { 'wdt:P3575': [fact('wdt:P3575', { amount: '+4', unit: 'wd:Q11574' })] },
  });
  expect([400, 422]).toContain(wrongUnit.response.status);
  const wrongTarget = await send('POST', '/v1/subjects', {
    type: 'rezics:AnimeRelease',
    labels: { en: 'Wrong associated target' },
    statements: { 'schema:associatedMedia': [fact('schema:associatedMedia', episode.id)] },
  });
  expect([400, 422]).toContain(wrongTarget.response.status);

  const page = await send('POST', '/v1/pages:read', { target: { subject: first.id }, languages: ['en'] });
  expect(page.response.status).toBe(200);
  expect(page.response.headers.get('cache-control')).toBe('private, no-store');
  expect(page.body.catalogue).toMatchObject({ state: 'released', type: 'schema:MediaObject', digest: bundledDigest });
  expect(page.body.catalogue.definitions.properties).toHaveProperty('wdt:P4092');
  expect(page.body.catalogue.definitions.properties).toHaveProperty('rezics:hashAlgorithm');
  expect(page.body.catalogue.definitions.properties).toHaveProperty('schema:associatedMedia');
  expect(page.body.viewer).toMatchObject({
    state: 'account',
    account: editor,
    context: GLOBAL_CONTEXT,
    actions: { statementPropose: 'allowed' },
  });
  expect(page.body.viewer.actions).toEqual({ statementPropose: 'allowed' });
  expect(page.body).not.toHaveProperty('copy');
  expect(page.body).not.toHaveProperty('progress');
  expect(page.body).not.toHaveProperty('entitlement');
  expect(
    Object.values(page.body.reads).some((read: any) => read.status === 200 && read.body.subject?.id === first.id),
  ).toBe(true);
  const anonymous = await send('POST', '/v1/pages:read', { target: { subject: first.id }, languages: ['en'] }, false);
  expect(anonymous.body.viewer).toMatchObject({ state: 'anonymous', actions: { statementPropose: 'denied' } });

  await write(`/v1/subjects/${group.id}:hide`, { reason: 'The group is independently withheld.' });
  expect((await send('GET', `/v1/subjects/${group.id}`, undefined, false)).response.status).toBe(404);
  const stillReadable = await send('GET', `/v1/subjects/${first.id}`, undefined, false);
  expect(stillReadable.response.status).toBe(200);
  expect(stillReadable.body.subject.statements['rezics:releaseGroup'][0].value.content).toBe(group.id);
  const hiddenGroupPage = await send(
    'POST',
    '/v1/pages:read',
    { target: { subject: first.id }, languages: ['en'] },
    false,
  );
  expect(hiddenGroupPage.response.status).toBe(200);
  expect(JSON.stringify(hiddenGroupPage.body)).not.toContain('Source group');
  const secondRead = await send('GET', `/v1/subjects/${second.id}`, undefined, false);
  expect(secondRead.body.subject.id).toBe(second.id);
  expect(secondRead.body.subject.statements['wdt:P4092'][0]).toMatchObject({
    value: value(hash),
    qualifiers: [qualifier('rezics:hashAlgorithm', 'future-v9')],
  });
});
