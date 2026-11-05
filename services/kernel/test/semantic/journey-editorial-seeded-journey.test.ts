import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { setupContent } from '../../src/content/setup.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { setupPresentation } from '../../src/presentation/setup.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { createRealAccess } from './real-access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const accounts = {
  editor: newId(0x5101),
  acceptor: newId(0x5102),
  outsider: newId(0x5103),
  delegated: newId(0x5104),
  suspended: newId(0x5105),
};
type Actor = keyof typeof accounts | null;
const actions = [
  'subject:create',
  'subject:read',
  'statement:propose',
  'context:create',
  'context:accept',
  'context:adopt',
  'subject:merge',
  'moderation:hide',
];
const real = await createRealAccess(admin, accounts, actions);
const kernel = createKernel({
  pool,
  access: real.access,
  tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(41)]]) },
  receiptKeys: testReceiptKeys(),
  routeKey: new Uint8Array(32).fill(42),
  writeRate: real.writeRate,
});

const language = 'schema:inLanguage';
const abstract = 'schema:abstract';
const citation = (id: string) => ({
  parts: [{ property: { id: 'schema:url' }, value: { type: 'value' as const, content: id } }],
});
const key = () => `"${randomUUID()}"`;
const snak = (id: string, content: unknown) => ({ property: { id }, value: { type: 'value' as const, content } });
const cited = (property: string, content: unknown, source: string) => ({
  ...snak(property, content),
  references: [citation(source)],
});

type HttpResponse = { status: number; headers: Headers; body: Record<string, any> };
type Statement = { id: string; rank: string; value: { type: string; content?: unknown } };
type Candidate = {
  id: string;
  deleted?: true;
  decision: string | null;
  rank: string | null;
  head: number | null;
  source: unknown;
  statement: { id?: string; value: { type: string; content?: unknown }; references: unknown[] };
};
type SubjectBody = {
  subject: {
    id: string;
    revision: number;
    context: string;
    statements: Record<string, Statement[]>;
  };
};

async function call(
  persona: Actor,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<HttpResponse> {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        ...(persona ? { authorization: `Bearer ${real.bearer(persona)}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        'idempotency-key': headers['Idempotency-Key'] ?? key(),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, headers: response.headers, body: (await response.json()) as Record<string, any> };
}

const write = (persona: Actor, path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(persona, 'POST', path, body, headers);
const get = (persona: Actor, path: string, headers: Record<string, string> = {}) =>
  call(persona, 'GET', path, undefined, headers);

function problem(response: HttpResponse, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  expect(response.body).toMatchObject({ status, code });
}

function subjectOf(response: HttpResponse): SubjectBody['subject'] {
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return (response.body as { subject: SubjectBody['subject'] }).subject;
}

function readSubject(response: HttpResponse): SubjectBody['subject'] {
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return (response.body as SubjectBody).subject;
}

function languages(subject: SubjectBody['subject']) {
  return (subject.statements[language] ?? []).map((statement) => ({
    id: statement.id,
    rank: statement.rank,
    content: statement.value.content,
  }));
}

async function propose(id: string, content: string, source: string, idempotency = key(), persona: Actor = 'editor') {
  const headers = { 'Idempotency-Key': idempotency };
  const response = await write(
    persona,
    `/v1/subjects/${id}/candidates`,
    { statement: cited(language, content, source) },
    headers,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  expect(typeof response.body.candidate).toBe('string');
  expect(typeof response.body.revision).toBe('number');
  return {
    id: response.body.candidate as string,
    revision: response.body.revision as number,
    headers,
    content,
    source,
  };
}

async function listCandidates(id: string, persona: Actor, limit = 20, cursor?: string) {
  const query = new URLSearchParams({
    property: language,
    context: GLOBAL_CONTEXT,
    limit: String(limit),
    ...(cursor ? { cursor } : {}),
  });
  const response = await get(persona, `/v1/subjects/${id}/candidates?${query}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body as {
    candidates: Candidate[];
    adoption: { mode: string; head: number } | null;
    next: string | null;
  };
}

async function inspectRevisions(subjectId: string) {
  const route = routeOf(subjectId);
  if (route === null) return [];
  const rows = await pool.query<{ revision: string; partition: string; transaction_id: string }>(
    `SELECT revision, route >> 4 AS partition,
            recorded_transaction_id::text AS transaction_id
       FROM semantic.revision
      WHERE route=$1 AND subject_id=$2
      ORDER BY revision`,
    [route, subjectId],
  );
  return rows.rows.map((row) => ({
    revision: Number(row.revision),
    partition: Number(row.partition),
    transactionId: row.transaction_id,
  }));
}

beforeAll(async () => {
  expect(await bootstrapRelease(pool, bundledRelease)).toBe(bundledDigest);
  await setupPresentation(pool);
  await setupContent(pool);
  for (const account of Object.values(accounts))
    await admin.query("UPDATE access.account SET rate_tier='trusted' WHERE route=$1 AND account_id=$2", [
      routeOf(account),
      account,
    ]);
  const global = { route: 0, id: GLOBAL_CONTEXT };
  for (const action of [
    'subject:create',
    'subject:read',
    'statement:propose',
    'context:create',
    'moderation:hide',
  ] as const)
    await real.grant(global, 'editor', action);
  for (const action of ['subject:read', 'context:accept', 'context:adopt', 'subject:merge'] as const)
    await real.grant(global, 'acceptor', action);
  await real.grant(global, 'delegated', 'statement:propose');
  for (const action of ['subject:create', 'statement:propose', 'context:create'] as const)
    await real.grant(global, 'suspended', action);
  await admin.query("UPDATE access.account SET state='suspended' WHERE route=$1 AND account_id=$2", [
    routeOf(accounts.suspended),
    accounts.suspended,
  ]);
}, 180_000);

afterAll(async () => {
  await pool.end();
  await admin.end();
}, 180_000);

test('cited competing proposals complete through acceptance, adoption and independent public readback', async () => {
  const englishSource = 'https://catalogue.example.test/editorial/en';
  const created = subjectOf(
    await write('editor', '/v1/subjects', {
      type: 'schema:Book',
      labels: { en: 'Cited editorial book' },
      statements: { [language]: [cited(language, 'en', englishSource)] },
    }),
  );
  expect(created.context).toBe(GLOBAL_CONTEXT);
  const createdEnglish = languages(created);
  expect(createdEnglish).toEqual([{ id: createdEnglish[0]!.id, rank: 'normal', content: 'en' }]);
  const afterCreate = await inspectRevisions(created.id);
  expect(afterCreate).toHaveLength(1);
  expect(new Set(afterCreate.map((row) => row.partition)).size).toBe(1);

  const replayKey = key();
  const japanese = await propose(created.id, 'ja', 'https://catalogue.example.test/editorial/ja', replayKey);
  const replayed = await write(
    'editor',
    `/v1/subjects/${created.id}/candidates`,
    { statement: cited(language, 'ja', 'https://catalogue.example.test/editorial/ja') },
    { 'Idempotency-Key': replayKey },
  );
  expect(replayed.status).toBe(201);
  expect(replayed.body).toMatchObject({ candidate: japanese.id, revision: japanese.revision });
  const korean = await propose(created.id, 'ko', 'https://catalogue.example.test/editorial/ko');
  const chinese = await propose(created.id, 'zh', 'https://catalogue.example.test/editorial/zh');

  const invalid = await write('editor', `/v1/subjects/${created.id}/candidates`, {
    statement: { property: { id: 'schema:inLanguage' }, value: { type: 'value', content: { not: 'a language' } } },
  });
  problem(invalid, 400, 'invalid_request');

  const pendingPublic = readSubject(await get(null, `/v1/subjects/${created.id}`));
  expect(languages(pendingPublic)).toEqual(createdEnglish);
  expect(pendingPublic.revision).toBe(created.revision);

  const listed = await listCandidates(created.id, 'acceptor');
  const byId = Object.fromEntries(listed.candidates.filter((row) => !row.deleted).map((row) => [row.id, row]));
  expect(byId[japanese.id]?.decision).toBeNull();
  expect(byId[korean.id]?.decision).toBeNull();
  expect(byId[chinese.id]?.decision).toBeNull();
  expect(byId[japanese.id]?.statement.references).toEqual([citation('https://catalogue.example.test/editorial/ja')]);
  expect(byId[japanese.id]?.source ?? null).not.toBe(undefined);

  const paged = await listCandidates(created.id, 'acceptor', 1);
  expect(paged.candidates).toHaveLength(1);
  expect(typeof paged.next).toBe('string');
  const continued = await listCandidates(created.id, 'acceptor', 1, paged.next!);
  expect(continued.candidates).toHaveLength(1);
  expect(continued.candidates[0]!.id).not.toBe(paged.candidates[0]!.id);

  expect(
    (
      await write('acceptor', `/v1/subjects/${created.id}/candidates/${japanese.id}:accept`, {
        context: GLOBAL_CONTEXT,
        expected_head: byId[japanese.id]?.head ?? null,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await write('acceptor', `/v1/subjects/${created.id}/candidates/${korean.id}:reject`, {
        context: GLOBAL_CONTEXT,
        expected_head: byId[korean.id]?.head ?? null,
      })
    ).status,
  ).toBe(200);
  const afterDecision = await listCandidates(created.id, 'acceptor');
  const decided = Object.fromEntries(
    afterDecision.candidates.filter((row) => !row.deleted).map((row) => [row.id, row]),
  );
  expect(decided[japanese.id]?.decision).toBe('accepted');
  expect(decided[korean.id]?.decision).toBe('rejected');
  expect(decided[chinese.id]?.decision).toBeNull();
  expect(languages(readSubject(await get(null, `/v1/subjects/${created.id}`)))).toEqual(createdEnglish);

  const adopted = await write('acceptor', `/v1/subjects/${created.id}:adopt`, {
    context: GLOBAL_CONTEXT,
    property: language,
    mode: 'replace',
    selection: [{ candidate: japanese.id, rank: 'preferred' }],
    expected_head: afterDecision.adoption?.head ?? null,
  });
  expect(adopted.status, JSON.stringify(adopted.body)).toBe(200);

  const publicAfter = readSubject(await get(null, `/v1/subjects/${created.id}`));
  expect(languages(publicAfter)).toEqual([{ id: japanese.id, rank: 'preferred', content: 'ja' }]);
  expect(JSON.stringify(publicAfter)).not.toContain(korean.id);
  expect(JSON.stringify(publicAfter)).not.toContain('ko');
  const ranked = await listCandidates(created.id, 'editor');
  expect(ranked.candidates.find((row) => row.id === japanese.id)?.rank).toBe('preferred');
  expect(ranked.candidates.find((row) => row.id === korean.id)?.decision).toBe('rejected');
  expect(ranked.candidates.find((row) => row.id === chinese.id)?.rank ?? null).toBeNull();

  const hidden = await write('editor', `/v1/subjects/${created.id}/candidates/${chinese.id}:hide`, {
    reason: 'Disputed language claim',
  });
  expect(hidden.status, JSON.stringify(hidden.body)).toBe(200);

  const room = await write('editor', '/v1/contexts', { labels: { en: 'Editorial room', 'zh-Hans': '编辑室' } });
  expect(room.status, JSON.stringify(room.body)).toBe(201);
  const contextId = (room.body as { context: { id: string } }).context.id;
  const contextResource = { route: routeOf(contextId)!, id: contextId };
  await real.grant(contextResource, 'acceptor', 'context:accept');
  await real.grant(contextResource, 'acceptor', 'context:adopt');
  const suppressed = await write('acceptor', `/v1/subjects/${created.id}:adopt`, {
    context: contextId,
    property: language,
    mode: 'suppress',
    selection: [],
    expected_head: null,
  });
  expect(suppressed.status, JSON.stringify(suppressed.body)).toBe(200);
  expect(languages(readSubject(await get(null, `/v1/subjects/${created.id}`)))).toEqual([
    { id: japanese.id, rank: 'preferred', content: 'ja' },
  ]);
  expect(languages(readSubject(await get(null, `/v1/subjects/${created.id}?context=${contextId}`)))).toEqual([]);
  const labelled = await get('editor', `/v1/contexts/${contextId}`);
  expect(labelled.status, JSON.stringify(labelled.body)).toBe(200);
  const labels = (labelled.body as { context: { labels: Record<string, string> } }).context.labels;
  expect(labels.en).toBe('Editorial room');
  const fallback = await get('editor', `/v1/contexts/${contextId}`, {
    'accept-language': 'zh-Hant, zh-Hans;q=0.8, en;q=0.1',
  });
  expect(fallback.status).toBe(200);

  const current = fromPlainText('The public abstract remains selected.');
  const replacement = fromPlainText('An original cited abstract for this catalogue.');
  const authored = subjectOf(
    await write('editor', '/v1/subjects', {
      type: 'schema:Book',
      labels: { en: 'Cited authored abstract' },
      statements: {
        [abstract]: [
          {
            ...snak(abstract, { document: current, language: 'en', licence: 'CC-BY-4.0' }),
            references: [citation('https://catalogue.example.test/editorial/abstract')],
            qualifiers: [],
            rank: 'normal',
          },
        ],
      },
    }),
  );
  const proposedAbstract = await write('editor', `/v1/subjects/${authored.id}/candidates`, {
    statement: {
      ...snak(abstract, { document: replacement, language: 'en', licence: 'CC-BY-4.0' }),
      references: [citation('https://catalogue.example.test/editorial/abstract-replacement')],
      qualifiers: [],
      rank: 'normal',
    },
  });
  expect(proposedAbstract.status, JSON.stringify(proposedAbstract.body)).toBe(201);
  const abstractCandidate = proposedAbstract.body.candidate as string;
  const abstractCandidates = await get(
    'acceptor',
    `/v1/subjects/${authored.id}/candidates?property=${encodeURIComponent(abstract)}&context=${GLOBAL_CONTEXT}&limit=20`,
  );
  expect(abstractCandidates.status).toBe(200);
  const abstractRow = (abstractCandidates.body as { candidates: Candidate[] }).candidates.find(
    (row) => row.id === abstractCandidate,
  );
  const documentLocator = abstractRow?.statement.value.content as {
    document?: string;
    digest?: string;
    language?: string;
  };
  expect(typeof documentLocator?.document).toBe('string');
  expect(typeof documentLocator?.digest).toBe('string');
  expect(documentLocator?.language).toBe('en');
  expect(
    (
      await write('acceptor', `/v1/subjects/${authored.id}/candidates/${abstractCandidate}:accept`, {
        context: GLOBAL_CONTEXT,
        expected_head: abstractRow?.head ?? null,
      })
    ).status,
  ).toBe(200);
  const abstractListed = await get(
    'acceptor',
    `/v1/subjects/${authored.id}/candidates?property=${encodeURIComponent(abstract)}&context=${GLOBAL_CONTEXT}&limit=20`,
  );
  expect(
    (
      await write('acceptor', `/v1/subjects/${authored.id}:adopt`, {
        context: GLOBAL_CONTEXT,
        property: abstract,
        mode: 'replace',
        selection: [{ candidate: abstractCandidate, rank: 'normal' }],
        expected_head: (abstractListed.body as { adoption: { head: number } | null }).adoption?.head ?? null,
      })
    ).status,
  ).toBe(200);
  const publicAuthored = readSubject(await get(null, `/v1/subjects/${authored.id}?includeDocuments=true`));
  expect(publicAuthored.statements[abstract]?.map((row) => row.id)).toEqual([abstractCandidate]);
  const publicDocument = await get(null, `/v1/documents/${documentLocator!.document}`);
  expect(publicDocument.status, JSON.stringify(publicDocument.body)).toBe(200);
  const document = (publicDocument.body as { document: Record<string, unknown> }).document;
  expect(document).toMatchObject({
    id: documentLocator!.document,
    subjectId: authored.id,
    candidateId: abstractCandidate,
    digest: documentLocator!.digest,
    language: 'en',
    availability: 'available',
  });

  const revisions = await get(null, `/v1/subjects/${created.id}/revisions?limit=20`);
  expect(revisions.status).toBe(200);
  const kinds = (revisions.body as { revisions: { revision: number; kind: string }[] }).revisions.map(
    (row) => row.kind,
  );
  expect(kinds).toEqual(expect.arrayContaining(['record', 'candidate', 'decision', 'adoption']));
  const inspected = await inspectRevisions(created.id);
  expect(inspected.length).toBeGreaterThanOrEqual(kinds.length);
  expect(new Set(inspected.map((row) => row.partition)).size).toBe(1);
  expect(new Set(inspected.map((row) => row.transactionId)).size).toBe(inspected.length);
  const adoptionRevision = (revisions.body as { revisions: { revision: number; kind: string }[] }).revisions.find(
    (row) => row.kind === 'adoption',
  );
  expect(adoptionRevision).toBeDefined();
  const detail = await get(null, `/v1/subjects/${created.id}/revisions/${adoptionRevision!.revision}`);
  expect(detail.status).toBe(200);
  expect((detail.body as { change: { kind: string; mode?: string } }).change).toMatchObject({
    kind: 'adoption',
    mode: 'replace',
  });
}, 180_000);

test('anonymous, outsider, delegated editor and suspended bearers keep editorial authorization at the native boundary', async () => {
  const created = subjectOf(
    await write('editor', '/v1/subjects', {
      type: 'schema:Book',
      labels: { en: 'Authorization book' },
    }),
  );
  const statement = { statement: cited(language, 'fr', 'https://catalogue.example.test/editorial/fr') };
  problem(await write(null, `/v1/subjects/${created.id}/candidates`, statement), 401, 'authentication_required');
  const suspended = await write('suspended', `/v1/subjects/${created.id}/candidates`, statement);
  problem(suspended, 401, 'invalid_credentials');
  expect(suspended.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');

  problem(await write('outsider', `/v1/subjects/${created.id}/candidates`, statement), 403, 'forbidden');

  const delegatedWrite = await write('delegated', `/v1/subjects/${created.id}/candidates`, statement);
  expect(delegatedWrite.status, JSON.stringify(delegatedWrite.body)).toBe(201);
  expect(typeof delegatedWrite.body.candidate).toBe('string');
  expect(languages(readSubject(await get(null, `/v1/subjects/${created.id}`)))).toEqual([]);
}, 180_000);
