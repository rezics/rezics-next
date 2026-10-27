import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import sharp from 'sharp';
import type { PoolClient, QueryConfig } from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import type { BatchCommand, BatchStatement, Rights, Source } from '@rezics/definitions/bulk';
import type { MediaImportRequest } from '@rezics/definitions/media-import';
import { fromPlainText } from '@rezics/document';
import { createAccess } from '../../src/access/index.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { processImage } from '../../src/content/image-job.ts';
import { processImportedMedia } from '../../src/content/media-import-job.ts';
import type { MediaStorage } from '../../src/content/media-storage.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const routeKey = new Uint8Array(32).fill(4);
const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(3)]]) };
const issuer = 'https://auth.example.test';
const audience = 'https://api.rezics.test';
const importerId = newId(0x5100);
const otherId = newId(0x5101);
const bareId = newId(0x5102);
const platformId = GLOBAL_CONTEXT;
const importerActions = [
  'subject:batch_write',
  'subject:create',
  'statement:propose',
  'subject:read',
  'context:accept',
  'context:adopt',
  'source_fence:takedown',
  'source_fence:read',
  'media:import_from_url',
  'media:read_reservation',
];
const otherActions = ['subject:batch_write', 'statement:propose', 'subject:read'];
const bareActions = ['subject:batch_write'];
const auth = {
  issuer,
  audience,
  jwksUrl: `${issuer}/.well-known/jwks.json`,
  fetch: async () => Response.json({ keys: [] as Record<string, unknown>[] }),
};

class ByteStore implements MediaStorage {
  readonly objects = new Map<string, { bytes: Uint8Array; mediaType: string }>();
  async get(key: string): Promise<Uint8Array | null> {
    const object = this.objects.get(key);
    return object ? Uint8Array.from(object.bytes) : null;
  }
  async put(key: string, bytes: Uint8Array, options: { mediaType: string }): Promise<void> {
    this.objects.set(key, { bytes: Uint8Array.from(bytes), mediaType: options.mediaType });
  }
  async deletePrefix(prefix: string): Promise<void> {
    for (const key of this.objects.keys()) if (key.startsWith(prefix)) this.objects.delete(key);
  }
}

let importer = '';
let other = '';
let bare = '';
let coverBytes = new Uint8Array();
const storage = new ByteStore();
const kernel = createKernel({
  pool,
  access: (config) => {
    // The kernel builds one Access from the first route group's catalogue. Content
    // actions used by this file must be present then, or later routes answer 403.
    const actions = new Map(config.actions);
    for (const action of [
      'media:import_from_url',
      'media:read_reservation',
      'media:read',
      'media:complete',
      'media:erase',
      'source_fence:read',
      'source_fence:takedown',
    ] as const)
      if (!actions.has(action)) actions.set(action, { anonymous: false });
    return createAccess({ ...config, actions, auth });
  },
  tokens,
  routeKey,
  writeRate: createWriteRateLimiter({
    secret: 'imported-fields-rate-test-secret-at-least-32b',
    overrides: '{"new-account":{"write":{"maximum":1000,"seconds":60},"upload":{"maximum":1000,"seconds":60}}}',
  }),
  content: { fetchConfig: { allowedHosts: ['images.example.test'] } },
});

beforeAll(async () => {
  expect(await bootstrapRelease(pool, bundledRelease)).toBe(bundledDigest);
  const keys = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(keys.publicKey)), alg: 'ES256', kid: 'imported-fields' };
  auth.fetch = async () => Response.json({ keys: [jwk] });
  for (const id of [importerId, otherId, bareId]) {
    await pool.query(
      `INSERT INTO access.account (route, account_id, kind, state, transaction_id) VALUES ($1, $2, 'actor', 'active', $2)`,
      [routeOf(id), id],
    );
  }
  for (const [id, actions] of [
    [importerId, importerActions],
    [otherId, otherActions],
    [bareId, bareActions],
  ] as const) {
    for (const action of actions) {
      await pool.query(
        `INSERT INTO access.resource_grant (route, resource_id, subject_id, action, valid, transaction_id)
         VALUES (0, $1, $2, $3, '(,)'::tstzrange, $2)`,
        [platformId, id, action],
      );
    }
  }
  const issue = (id: string, actions: readonly string[]) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      client_id: 'web',
      scope: actions.join(' '),
      authn_epoch: 1,
      auth_time: now,
      amr: ['pwd'],
    })
      .setProtectedHeader({ alg: 'ES256', kid: jwk.kid, typ: 'at+jwt' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(id)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(keys.privateKey);
  };
  importer = await issue(importerId, importerActions);
  other = await issue(otherId, otherActions);
  bare = await issue(bareId, bareActions);
  coverBytes = await sharp({ create: { width: 96, height: 64, channels: 3, background: '#336699' } })
    .jpeg()
    .toBuffer();
});
afterAll(async () => {
  await pool.end();
});

async function call(method: string, path: string, options: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    if (!path.endsWith(':batchWrite')) headers['idempotency-key'] = `"${randomUUID()}"`;
  }
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
  return { response, body: (await response.json()) as Record<string, any> };
}
const batch = (commands: unknown[], token = importer) =>
  call('POST', '/v1/subjects:batchWrite', { token, body: { commands } });
const value = (content: unknown) => ({ type: 'value' as const, content });
const statement = (property: string, content: unknown) => ({ property: { id: property }, value: value(content) });
const record = (externalId: string, overrides: Partial<Source> = {}): Source => ({
  source: 'openlibrary',
  external_id: externalId,
  record_revision: 'unversioned',
  digest: 'c'.repeat(64),
  converter_revision: 'openlibrary@1',
  field_group: 'facts',
  ...overrides,
});
const cited = (property: string, content: unknown, url = 'https://openlibrary.org/works/OL1W'): BatchStatement => ({
  ...statement(property, content),
  references: [{ parts: [statement('schema:url', url)] }],
});
const work = (title: string) => ({ type: 'schema:Book', labels: { en: title } });
const rights: Rights = {
  license: 'CC-BY-SA-3.0',
  obligations: ['cc:Attribution', 'cc:ShareAlike'],
  attribution: 'Open Library contributors',
};
const summary = (externalId: string, subject: string, text: string, key: string, url: string): BatchCommand => ({
  op: 'propose',
  key,
  source: record(externalId, { field_group: 'summary' }),
  subject,
  statement: cited('schema:abstract', { language: 'ja', document: fromPlainText(text) }, url),
  rights,
});

function requireStatus(step: string, answer: { response: Response; body: Record<string, any> }, status: number) {
  if (answer.response.status !== status)
    throw new Error(`${step} returned ${answer.response.status}: ${JSON.stringify(answer.body)}`);
  return answer.body;
}
function commandAt(
  step: string,
  answer: { response: Response; body: Record<string, any> },
  index: number,
  status: number,
) {
  const result = answer.body.results?.[index] as Record<string, any> | undefined;
  if (answer.response.status !== 200 || result?.status !== status)
    throw new Error(`${step} returned ${answer.response.status}/${result?.status}: ${JSON.stringify(answer.body)}`);
  return result;
}

async function createBook(title: string, externalId = `OL${randomUUID()}W`) {
  const created = await batch([
    { op: 'create', key: `create-${externalId}`, source: record(externalId), subject: work(title) },
  ]);
  const result = commandAt('create', created, 0, 201);
  return { id: result.value.id as string, externalId, revision: result.value.revision as number };
}

async function acceptAndAdopt(id: string, property: string, candidate: string) {
  requireStatus(
    'accept',
    await call('POST', `/v1/subjects/${id}/candidates/${candidate}:accept`, {
      token: importer,
      body: { context: GLOBAL_CONTEXT, expected_head: null },
    }),
    200,
  );
  requireStatus(
    'adopt',
    await call('POST', `/v1/subjects/${id}:adopt`, {
      token: importer,
      body: {
        context: GLOBAL_CONTEXT,
        property,
        mode: 'replace',
        selection: [{ candidate, rank: 'normal' }],
        expected_head: null,
      },
    }),
    200,
  );
}

async function fence(source: string, externalId: string, fieldGroup: 'facts' | 'summary' | 'cover') {
  requireStatus(
    'fence',
    await call('POST', '/v1/sourceFences:takedown', {
      token: importer,
      body: { source, externalId, fieldGroup, reason: 'Taken down for the imported field test.' },
    }),
    200,
  );
}

async function documentCount(subject: string) {
  const rows = await pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM content.imported_field WHERE subject = $1',
    [subject],
  );
  return rows.rows[0]!.count;
}

async function leaked(token: string) {
  const rows = await pool.query<{ hits: number }>(
    `SELECT (
       (SELECT count(*) FROM semantic.candidate WHERE statement::text LIKE '%' || $1 || '%') +
       (SELECT count(*) FROM semantic.revision WHERE source::text LIKE '%' || $1 || '%') +
       (SELECT count(*) FROM core.receipt WHERE response::text LIKE '%' || $1 || '%') +
       (SELECT count(*) FROM core.outbox WHERE data::text LIKE '%' || $1 || '%')
     )::int AS hits`,
    [token],
  );
  return rows.rows[0]!.hits;
}

async function availableCover(subject: string, externalId: string) {
  const provenance: MediaImportRequest['provenance'] = {
    source: 'catalogue',
    external_id: externalId,
    record_revision: '1',
    digest: 'b'.repeat(64),
    converter_revision: 'catalogue@1',
    field_group: 'cover',
    references: [{ parts: [statement('schema:url', `https://catalogue.example.test/${externalId}`)] }],
  };
  const input: MediaImportRequest = {
    containerId: subject,
    sourceUrl: 'https://images.example.test/cover.jpg',
    credit: {
      rightsHolder: 'Cover Artist',
      via: { name: 'Catalogue', url: 'https://catalogue.example.test/via' },
      license: 'LicenseRef-unknown',
      obligations: [],
    },
    provenance,
  };
  const reserved = await call('POST', '/v1/media:importFromUrl', { token: importer, body: input });
  requireStatus('import', reserved, 202);
  const mediaId = reserved.body.media.id as string;
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(url) === input.sourceUrl)
      return new Response(coverBytes, {
        headers: { 'content-type': 'image/jpeg', 'content-length': String(coverBytes.byteLength) },
      });
    return original(url, init);
  }) as typeof fetch;
  try {
    const uploaded = await processImportedMedia(
      {
        pool,
        access: createAccess({ actions: new Map(), auth }),
        routeKey,
        clock: () => new Date(),
        fetchConfig: { allowedHosts: ['images.example.test'] },
        storage,
      },
      mediaId,
    );
    if (uploaded.state !== 'uploaded') throw new Error(`import job ${JSON.stringify(uploaded)}`);
  } finally {
    globalThis.fetch = original;
  }
  const image = await processImage(pool, storage, mediaId);
  if (image.state !== 'available') throw new Error(`image job ${JSON.stringify(image)}`);
  return mediaId;
}

test("a summary proposal stores content's document reference and never the body", async () => {
  const token = `BodyToken${randomUUID()}`;
  const book = await createBook('Kokoro');
  const direct = await call('POST', `/v1/subjects/${book.id}/candidates`, {
    token: importer,
    body: {
      statement: cited('schema:abstract', { language: 'ja', document: fromPlainText(token), licence: 'CC-BY-SA-3.0' }),
    },
  });
  expect(direct.response.status).toBe(201);
  const authored = await pool.query('SELECT licence, language FROM content.authored_field WHERE candidate = $1', [
    direct.body.candidate,
  ]);
  expect(authored.rows).toEqual([{ licence: 'CC-BY-SA-3.0', language: 'ja' }]);

  const proposed = await batch([
    summary(book.externalId, book.id, token, 'summary', 'https://openlibrary.org/works/OL1W'),
  ]);
  const result = commandAt('summary', proposed, 0, 201);
  const candidate = result.value.candidate as string;
  const stored = await pool.query<{ content: { language: string; document: string; digest: string }; held: boolean }>(
    `SELECT c.statement -> 'value' -> 'content' AS content,
            position(convert_to($3, 'UTF8') IN f.body) > 0 AS held
     FROM semantic.candidate c
     JOIN content.imported_field f ON f.subject = c.subject_id AND f.candidate = c.candidate_id
     WHERE c.subject_id = $1 AND c.candidate_id = $2`,
    [book.id, candidate, token],
  );
  expect(stored.rows).toHaveLength(1);
  expect(stored.rows[0]!.held).toBe(true);
  expect(stored.rows[0]!.content).toEqual({
    language: 'ja',
    document: expect.stringMatching(/^[0-9a-f-]{36}$/),
    digest: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  expect(stored.rows[0]!.content.document).not.toBe(candidate);
  expect(await leaked(token)).toBe(0);

  await acceptAndAdopt(book.id, 'schema:abstract', candidate);
  const shown = requireStatus('read', await call('GET', `/v1/subjects/${book.id}`, { token: importer }), 200);
  expect(shown.subject.statements['schema:abstract'][0].value.content).toEqual(stored.rows[0]!.content);
  expect(JSON.stringify(shown)).not.toContain(token);
});

test('a summary transaction retry retains the source document and stores it once', async () => {
  const book = await createBook('Retry summary');
  const token = `BodyToken${randomUUID()}`;
  const originals = new Map<PoolClient, PoolClient['query']>();
  let retried = false;
  const intercept = (client: PoolClient) => {
    if (originals.has(client)) return;
    const query = client.query;
    originals.set(client, query);
    client.query = ((statement: QueryConfig | string, ...args: unknown[]) => {
      const text = typeof statement === 'string' ? statement : statement.text;
      // The content install has replaced the candidate's document body before
      // the command fence commits. Retry that complete transaction once.
      if (!retried && text.includes('INSERT INTO core.receipt')) {
        retried = true;
        throw Object.assign(new Error('Retry imported summary transaction'), { code: '40001' });
      }
      return Reflect.apply(query, client, [statement, ...args]);
    }) as PoolClient['query'];
  };
  pool.on('acquire', intercept);
  let proposed!: Awaited<ReturnType<typeof batch>>;
  try {
    proposed = await batch([
      summary(book.externalId, book.id, token, 'retry-summary', 'https://openlibrary.org/works/OL1W'),
    ]);
  } finally {
    pool.off('acquire', intercept);
    for (const [client, query] of originals) client.query = query;
  }
  expect(retried).toBe(true);
  const result = commandAt('retried summary', proposed, 0, 201);
  expect(await documentCount(book.id)).toBe(1);
  const stored = await pool.query(
    `SELECT position(convert_to($3, 'UTF8') IN body) > 0 AS held
     FROM content.imported_field WHERE subject = $1 AND candidate = $2`,
    [book.id, result.value.candidate, token],
  );
  expect(stored.rows).toEqual([{ held: true }]);
  expect(await leaked(token)).toBe(0);
});

test('an unchanged summary refresh appends no document', async () => {
  const token = `BodyToken${randomUUID()}`;
  const book = await createBook('Botchan');
  const first = await batch([
    summary(book.externalId, book.id, token, 'summary', 'https://openlibrary.org/works/OL1W'),
  ]);
  const created = commandAt('summary', first, 0, 201);
  const candidate = created.value.candidate as string;
  expect(await documentCount(book.id)).toBe(1);

  const again = await batch([
    summary(book.externalId, book.id, token, 'summary-again', 'https://openlibrary.org/works/OL1W.json'),
  ]);
  const refreshed = commandAt('refresh', again, 0, 200);
  expect(refreshed.value).toEqual({ candidate, revision: created.value.revision });
  expect(await documentCount(book.id)).toBe(1);
  expect(await leaked(token)).toBe(0);
});

test('a cover proposal claims an available cover media object in its own transaction', async () => {
  const book = await createBook('Sanshiro');
  const mediaId = await availableCover(book.id, `media-${randomUUID()}`);
  const cover = (key: string, url: string): BatchCommand => ({
    op: 'propose',
    key,
    source: record(book.externalId, { field_group: 'cover' }),
    subject: book.id,
    statement: cited('schema:image', mediaId, url),
  });
  const proposed = await batch([
    cover('cover', 'https://openlibrary.org/works/OL1W'),
    {
      op: 'propose',
      key: 'bad',
      source: record(book.externalId),
      subject: book.id,
      statement: cited('schema:inLanguage', 42),
    },
  ]);
  const result = commandAt('cover', proposed, 0, 201);
  expect(proposed.body.results[1].status).toBe(400);
  const candidate = result.value.candidate as string;
  const claim = await pool.query<{ claimed_at: Date | null; content: string }>(
    `SELECT m.claimed_at, c.statement -> 'value' ->> 'content' AS content
     FROM content.media m
     JOIN semantic.candidate c ON c.subject_id = $1 AND c.candidate_id = $2
     WHERE m.media_id = $3`,
    [book.id, candidate, mediaId],
  );
  expect(claim.rows[0]!.content).toBe(mediaId);
  expect(claim.rows[0]!.claimed_at).not.toBeNull();

  const again = await batch([cover('cover-again', 'https://openlibrary.org/works/OL1W.json')]);
  expect(commandAt('cover refresh', again, 0, 200).value.candidate).toBe(candidate);
  const claims = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM semantic.candidate WHERE subject_id = $1 AND property = 'schema:image'`,
    [book.id],
  );
  expect(claims.rows[0]!.count).toBe(1);
  await acceptAndAdopt(book.id, 'schema:image', candidate);
  const shown = requireStatus('read', await call('GET', `/v1/subjects/${book.id}`, { token: importer }), 200);
  expect(shown.subject.statements['schema:image'][0].value.content).toBe(mediaId);
});

test('a fenced source tuple refuses new contributions and hides existing ones at read', async () => {
  const token = `BodyToken${randomUUID()}`;
  const book = await createBook('I Am a Cat');
  const facts = {
    op: 'propose' as const,
    key: 'language',
    source: record(book.externalId),
    subject: book.id,
    statement: cited('schema:inLanguage', 'ja'),
  };
  const summaryCommand = summary(book.externalId, book.id, token, 'summary', 'https://openlibrary.org/works/OL1W');
  const proposed = await batch([facts, summaryCommand]);
  const language = commandAt('facts', proposed, 0, 201).value.candidate as string;
  const candidate = commandAt('summary', proposed, 1, 201).value.candidate as string;
  const documents = await documentCount(book.id);
  const listed = requireStatus(
    'list',
    await call('GET', `/v1/subjects/${book.id}/candidates?property=schema%3Aabstract`, { token: importer }),
    200,
  );
  expect(listed.candidates.map((row: { id: string }) => row.id)).toContain(candidate);
  await acceptAndAdopt(book.id, 'schema:inLanguage', language);
  await acceptAndAdopt(book.id, 'schema:abstract', candidate);
  const shown = requireStatus('read', await call('GET', `/v1/subjects/${book.id}`, { token: importer }), 200);
  expect(shown.subject.statements['schema:inLanguage'][0].value.content).toBe('ja');
  expect(shown.subject.statements['schema:abstract'][0].value.content.document).toEqual(expect.any(String));
  expect(JSON.stringify(shown)).not.toContain(token);
  const source = subjectSource(pool, routeKey);
  const indexed = await source.read(partitionOf(routeOf(book.id)!), [book.id]);
  expect(indexed.subjects[0]!.statements.map((row) => row.value)).toContain('ja');
  expect(JSON.stringify(indexed, (_key, item) => (typeof item === 'bigint' ? item.toString() : item))).not.toContain(
    token,
  );

  await fence('openlibrary', book.externalId, 'facts');
  const afterFacts = requireStatus(
    'read fenced facts',
    await call('GET', `/v1/subjects/${book.id}`, { token: importer }),
    200,
  );
  expect(afterFacts.subject.statements['schema:inLanguage']).toBeUndefined();
  expect(afterFacts.subject.statements['schema:abstract'][0].value.content.language).toBe('ja');
  const hiddenFacts = await source.read(partitionOf(routeOf(book.id)!), [book.id]);
  expect(hiddenFacts.subjects[0]!.statements.map((row) => row.value)).not.toContain('ja');
  const refused = await batch([
    { ...facts, key: 'language-new' },
    facts,
    { op: 'create', key: 'create-again', source: record(book.externalId), subject: work('I Am a Cat') },
  ]);
  for (const result of refused.body.results as Record<string, any>[]) {
    expect(result.status).toBe(409);
    expect(result.problem).toMatchObject({
      type: 'https://rezics.com/problems/fenced',
      title: 'Fenced',
      status: 409,
      code: 'fenced',
      retryable: false,
      effect_status: 'not_applied',
    });
  }

  await fence('openlibrary', book.externalId, 'summary');
  const afterSummary = requireStatus(
    'list fenced summary',
    await call('GET', `/v1/subjects/${book.id}/candidates?property=schema%3Aabstract`, { token: importer }),
    200,
  );
  expect(afterSummary.candidates.map((row: { id: string }) => row.id)).not.toContain(candidate);
  const hiddenSummary = requireStatus(
    'read fenced summary',
    await call('GET', `/v1/subjects/${book.id}`, { token: importer }),
    200,
  );
  expect(hiddenSummary.subject.statements['schema:abstract']).toBeUndefined();
  const refresh = await batch([
    summary(book.externalId, book.id, token, 'summary-refresh', 'https://openlibrary.org/works/OL1W.json'),
    summaryCommand,
  ]);
  expect(refresh.body.results.map((result: { status: number }) => result.status)).toEqual([409, 409]);
  expect(await documentCount(book.id)).toBe(documents);
  expect(await leaked(token)).toBe(0);
});

test('a failed summary or cover command leaves no document and no claim', async () => {
  const summaryBook = await createBook('And Then');
  const failedSummary = await batch([
    {
      op: 'propose',
      key: 'bad-summary',
      source: record(summaryBook.externalId, { source: 'bangumi', field_group: 'summary' }),
      subject: summaryBook.id,
      statement: cited('schema:abstract', {
        language: 'ja',
        document: fromPlainText(`BodyToken${randomUUID()}`),
      }),
      rights: { license: 'CC-BY-SA-3.0', obligations: ['cc:Attribution'], attribution: 'Bangumi contributors' },
    },
  ]);
  const summaryResult = commandAt('bad summary', failedSummary, 0, 400);
  expect(summaryResult.problem.errors).toContainEqual({
    pointer: '/commands/0/statement/value/content',
    code: 'out_of_range',
  });
  expect(await documentCount(summaryBook.id)).toBe(0);
  const summaryCandidates = await pool.query(
    `SELECT 1 FROM semantic.candidate WHERE subject_id = $1 AND property = 'schema:abstract'`,
    [summaryBook.id],
  );
  expect(summaryCandidates.rows).toHaveLength(0);
  const summaryReceipt = await pool.query('SELECT 1 FROM core.receipt WHERE idempotency_key = $1', ['bad-summary']);
  expect(summaryReceipt.rows).toHaveLength(0);

  const coverBook = await createBook('Kusamakura');
  const mediaId = await availableCover(coverBook.id, `media-${randomUUID()}`);
  const failedCover = await batch(
    [
      {
        op: 'propose',
        key: 'bad-cover',
        source: record(coverBook.externalId, { field_group: 'cover' }),
        subject: coverBook.id,
        statement: cited('schema:image', mediaId),
      },
    ],
    other,
  );
  const coverResult = commandAt('bad cover', failedCover, 0, 400);
  expect(coverResult.problem.errors).toContainEqual({
    pointer: '/commands/0/statement/value/content',
    code: 'out_of_range',
  });
  const media = await pool.query<{ claimed_at: Date | null }>(
    'SELECT claimed_at FROM content.media WHERE media_id = $1',
    [mediaId],
  );
  expect(media.rows[0]!.claimed_at).toBeNull();
  const coverCandidates = await pool.query(
    `SELECT 1 FROM semantic.candidate WHERE subject_id = $1 AND property = 'schema:image'`,
    [coverBook.id],
  );
  expect(coverCandidates.rows).toHaveLength(0);
  const coverReceipt = await pool.query('SELECT 1 FROM core.receipt WHERE idempotency_key = $1', ['bad-cover']);
  expect(coverReceipt.rows).toHaveLength(0);
});

async function takeDownMedia(mediaId: string) {
  await pool.query(
    'UPDATE content.media SET taken_down = true, security_revision = security_revision + 1 WHERE media_id = $1',
    [mediaId],
  );
}
async function coverEffects(subject: string, mediaId: string) {
  const rows = await pool.query<{ candidates: number; revisions: number; claimed: boolean }>(
    `SELECT
       (SELECT count(*) FROM semantic.candidate WHERE subject_id = $1 AND property = 'schema:image')::int AS candidates,
       (SELECT count(*) FROM semantic.revision WHERE subject_id = $1)::int AS revisions,
       (SELECT claimed_at IS NOT NULL FROM content.media WHERE media_id = $2) AS claimed`,
    [subject, mediaId],
  );
  return rows.rows[0]!;
}
async function receiptCount(keys: string[]) {
  const rows = await pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM core.receipt WHERE idempotency_key = ANY($1)',
    [keys],
  );
  return rows.rows[0]!.count;
}
const coverCommand = (book: { id: string; externalId: string }, mediaId: unknown, key: string): BatchCommand => ({
  op: 'propose',
  key,
  source: record(book.externalId, { field_group: 'cover' }),
  subject: book.id,
  statement: cited('schema:image', mediaId),
});

test('cover availability verdict follows command authorization and the current tuple fence', async () => {
  const book = await createBook('Botchan');
  const mediaId = await availableCover(book.id, `media-${randomUUID()}`);
  const ok = `ok-${randomUUID()}`;
  const first = await batch([coverCommand(book, mediaId, ok)]);
  commandAt('available cover', first, 0, 201);

  // An authorized caller meets the availability verdict only when the tuple is not fenced.
  const free = await createBook('Kokoro');
  const freeMedia = await availableCover(free.id, `media-${randomUUID()}`);
  await takeDownMedia(freeMedia);
  const missing = await batch([coverCommand(free, freeMedia, `missing-${randomUUID()}`)]);
  const refused = commandAt('unavailable cover', missing, 0, 400);
  expect(refused.problem.errors).toContainEqual({
    pointer: '/commands/0/statement/value/content',
    code: 'out_of_range',
  });
  expect(await coverEffects(free.id, freeMedia)).toEqual({ candidates: 0, revisions: 1, claimed: false });

  // Malformed media ids stay syntactic and write nothing.
  const malformedKey = `malformed-${randomUUID()}`;
  const malformed = await batch([coverCommand(free, 'not-a-media-id', malformedKey)]);
  const bad = commandAt('malformed cover', malformed, 0, 400);
  expect(bad.problem.errors).toContainEqual({ pointer: '/commands/0/statement/value/content', code: 'invalid_format' });
  expect(await receiptCount([malformedKey])).toBe(0);

  // The tuple is taken down and the media disappears: the replay is fenced, not unavailable.
  await fence('openlibrary', book.externalId, 'cover');
  await takeDownMedia(mediaId);
  const before = await coverEffects(book.id, mediaId);
  const receipts = await receiptCount([ok]);
  const replay = await batch([coverCommand(book, mediaId, ok)]);
  expect(commandAt('fenced replay', replay, 0, 409).problem).toMatchObject({ code: 'fenced', status: 409 });
  expect(await coverEffects(book.id, mediaId)).toEqual(before);
  expect(await receiptCount([ok])).toBe(receipts);
});

test('unauthorized cover commands do not reveal whether the media is available', async () => {
  const book = await createBook('Light and Dark');
  const mediaId = await availableCover(book.id, `media-${randomUUID()}`);
  const gone = await createBook('Grass on the Wayside');
  const goneMedia = await availableCover(gone.id, `media-${randomUUID()}`);
  await takeDownMedia(goneMedia);
  const keys = [0, 1, 2, 3].map((i) => `denied-${i}-${randomUUID()}`);
  const answer = async (command: BatchCommand) => commandAt('denied cover', await batch([command], bare), 0, 403);
  const shape = (result: Record<string, any>) => {
    const { request_id: _id, ...problem } = result.problem;
    return { status: result.status, problem };
  };
  const denied = shape(await answer(coverCommand(book, mediaId, keys[0]!)));
  expect(shape(await answer(coverCommand(gone, goneMedia, keys[1]!)))).toEqual(denied);
  expect(denied.problem).toMatchObject({ status: 403, code: 'forbidden' });

  await fence('openlibrary', book.externalId, 'cover');
  await fence('openlibrary', gone.externalId, 'cover');
  expect(shape(await answer(coverCommand(book, mediaId, keys[2]!)))).toEqual(denied);
  expect(shape(await answer(coverCommand(gone, goneMedia, keys[3]!)))).toEqual(denied);

  expect(await receiptCount(keys)).toBe(0);
  expect(await coverEffects(book.id, mediaId)).toEqual({ candidates: 0, revisions: 1, claimed: false });
  expect(await coverEffects(gone.id, goneMedia)).toEqual({ candidates: 0, revisions: 1, claimed: false });
});

test('a source retracts its summary and cover candidates without a content hook', async () => {
  const book = await createBook('The Gate');
  const mediaId = await availableCover(book.id, `media-${randomUUID()}`);
  const token = `BodyToken${randomUUID()}`;
  const proposed = await batch([
    summary(book.externalId, book.id, token, 'summary', 'https://openlibrary.org/works/OL1W'),
    {
      op: 'propose',
      key: 'cover',
      source: record(book.externalId, { field_group: 'cover' }),
      subject: book.id,
      statement: cited('schema:image', mediaId),
    },
  ]);
  const summaryCandidate = commandAt('summary', proposed, 0, 201).value.candidate as string;
  const coverCandidate = commandAt('cover', proposed, 1, 201).value.candidate as string;
  const documents = await documentCount(book.id);
  const claimed = await pool.query<{ claimed_at: Date | null }>(
    'SELECT claimed_at FROM content.media WHERE media_id = $1',
    [mediaId],
  );
  expect(documents).toBe(1);
  expect(claimed.rows[0]!.claimed_at).not.toBeNull();

  const missing = randomUUID();
  const replies = await batch([
    {
      op: 'retract',
      key: 'missing',
      source: record(book.externalId, { field_group: 'summary' }),
      subject: book.id,
      candidate: missing,
      references: [{ parts: [statement('schema:url', 'https://openlibrary.org/works/OL1W')] }],
    },
    {
      op: 'retract',
      key: 'other-source',
      source: record(book.externalId, { source: 'bangumi', field_group: 'summary' }),
      subject: book.id,
      candidate: summaryCandidate,
      references: [{ parts: [statement('schema:url', 'https://bgm.tv/subject/1')] }],
    },
    {
      op: 'retract',
      key: 'retract-summary',
      source: record(book.externalId, { field_group: 'summary' }),
      subject: book.id,
      candidate: summaryCandidate,
      references: [{ parts: [statement('schema:url', 'https://openlibrary.org/works/OL1W')] }],
    },
    {
      op: 'retract',
      key: 'retract-cover',
      source: record(book.externalId, { field_group: 'cover' }),
      subject: book.id,
      candidate: coverCandidate,
      references: [{ parts: [statement('schema:url', 'https://openlibrary.org/works/OL1W')] }],
    },
  ]);
  expect(commandAt('missing', replies, 0, 404).problem.code).toBe('not_found');
  expect(commandAt('other source', replies, 1, 409).problem.code).toBe('conflict');
  expect(commandAt('retract summary', replies, 2, 200).value.revision).toEqual(expect.any(Number));
  expect(commandAt('retract cover', replies, 3, 200).value.revision).toEqual(expect.any(Number));
  expect(await documentCount(book.id)).toBe(documents);
  const stillClaimed = await pool.query<{ claimed_at: Date | null }>(
    'SELECT claimed_at FROM content.media WHERE media_id = $1',
    [mediaId],
  );
  expect(stillClaimed.rows[0]!.claimed_at).toEqual(claimed.rows[0]!.claimed_at);
  const listing = requireStatus(
    'retracted',
    await call('GET', `/v1/subjects/${book.id}/candidates?property=schema%3Aabstract`, { token: importer }),
    200,
  );
  expect(listing.candidates).toContainEqual(
    expect.objectContaining({ id: summaryCandidate, retracted: expect.any(Number) }),
  );
  expect(await leaked(token)).toBe(0);
});
