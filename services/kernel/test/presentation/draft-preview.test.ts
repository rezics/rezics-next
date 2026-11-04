import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  MAX_PROFILE_BYTES,
  PROFILE_FORMAT,
  profileDigest,
  type CompositionDocument,
  type PresentationProfile,
} from '@rezics/composition';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { newId } from '../../src/route/route.ts';
import { createRealAccess } from '../semantic/real-access.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const accounts = { curator: newId(0), reader: newId(0) };
const access = await createRealAccess(admin, accounts, [
  'presentation:read',
  'presentation:publish',
  'presentation:activate',
  'subject:create',
  'context:create',
  'space:create',
  'realm:create',
  'realm:read',
  'subject:merge',
  'gate:subject_identity',
]);
let failLinks = false;
let pausedLinks: { context: string; reached: () => void; release: Promise<void>; used: boolean } | null = null;
const kernel = createKernel({
  pool,
  access: access.access,
  writeRate: access.writeRate,
  routeKey: new Uint8Array(32).fill(6),
  receiptKeys: testReceiptKeys(),
  requestDeadlineMs: 30_000,
});
kernel.wrap((handle) => async (request) => {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname.endsWith('/links') && failLinks)
    return Response.json({ code: 'source_unavailable' }, { status: 503 });
  const response = await handle(request);
  const pause = pausedLinks;
  if (
    pause &&
    !pause.used &&
    request.method === 'GET' &&
    url.pathname.endsWith('/links') &&
    url.searchParams.get('context') === pause.context
  ) {
    pause.used = true;
    pause.reached();
    await pause.release;
  }
  return response;
});
const document = (text: string) => ({
  root: { props: {} },
  content: [{ type: 'Heading', props: { id: 'heading', text, level: 2 } }],
});
const candidate = (): PresentationProfile => ({
  format: PROFILE_FORMAT,
  generic: { views: { overview: document('Unpublished overview'), details: document('Unpublished companion') } },
  bases: [],
  types: [],
  routes: [{ route: '/captured', document: document('Unpublished route') }],
});
async function call(
  path: string,
  body: unknown,
  persona: 'curator' | 'reader' | null = 'curator',
  method: 'GET' | 'POST' | 'PATCH' = 'POST',
  extraHeaders: Record<string, string> = {},
) {
  const headers = new Headers(extraHeaders);
  if (body !== undefined) headers.set('content-type', 'application/json');
  if (method !== 'GET') headers.set('idempotency-key', JSON.stringify(randomUUID()));
  if (persona) headers.set('authorization', `Bearer ${access.bearer(persona)}`);
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { response, body: (await response.json()) as Record<string, any> };
}
const preview = (profile: unknown, target: unknown, persona: 'curator' | 'reader' | null = 'curator') =>
  call('/v1/pages:previewDraft', { profile, target, languages: ['en'] }, persona);
async function storage() {
  return (
    await admin.query(`SELECT
    (SELECT count(*) FROM presentation.profile) AS profiles,
    (SELECT count(*) FROM presentation.profile_activation) AS heads,
    (SELECT count(*) FROM core.receipt) AS receipts`)
  ).rows[0];
}
async function makeContext(label: string) {
  const created = await call('/v1/contexts', { labels: { en: label } });
  expect(created.response.status, JSON.stringify(created.body)).toBe(201);
  return created.body.context.id as string;
}
async function makeRealm(contextId: string) {
  const space = await call('/v1/spaces', { title: 'Draft preview Realm host' });
  expect(space.response.status, JSON.stringify(space.body)).toBe(201);
  const created = await call('/v1/realms', {
    spaceId: space.body.space.spaceId,
    title: 'Draft preview Realm',
    visibility: 'protected',
    contextId,
  });
  expect(created.response.status, JSON.stringify(created.body)).toBe(201);
  const realm = created.body.realm as { realmId: string; title: string; headRevisionId: string };
  await access.grant({ route: 0, id: realm.realmId }, 'curator', 'realm:read');
  await access.grant({ route: 0, id: realm.realmId }, 'reader', 'realm:read');
  return realm;
}
async function publishToRealm(realmId: string, subjectId: string) {
  const result = await call(`/v1/realms/${realmId}/publications`, { subjectId });
  expect(result.response.status, JSON.stringify(result.body)).toBe(201);
}
async function adoptUrlInContext(contextId: string, url: string) {
  const proposed = await call(`/v1/subjects/${subject}/candidates`, {
    statement: {
      property: { id: 'schema:url' },
      value: { type: 'value', content: url },
      references: [],
      qualifiers: [],
    },
  });
  expect(proposed.response.status, JSON.stringify(proposed.body)).toBe(201);
  const candidateId = proposed.body.candidate as string;
  const accepted = await call(`/v1/subjects/${subject}/candidates/${candidateId}:accept`, {
    context: contextId,
    expected_head: null,
  });
  expect(accepted.response.status, JSON.stringify(accepted.body)).toBe(200);
  const adopted = await call(`/v1/subjects/${subject}:adopt`, {
    context: contextId,
    property: 'schema:url',
    mode: 'replace',
    selection: [{ candidate: candidateId, rank: 'normal' }],
    expected_head: null,
  });
  expect(adopted.response.status, JSON.stringify(adopted.body)).toBe(200);
}
let subject: string;
beforeAll(async () => {
  await bootstrapRelease(pool, bundledRelease);
  await admin.query(
    `INSERT INTO semantic.context (route,context_id,kind,labels,defaults,recorded_transaction_id)
    VALUES (0,$1,'global','{"en":"Global"}','{}',$2) ON CONFLICT DO NOTHING`,
    [GLOBAL_CONTEXT, randomUUID()],
  );
  for (const action of ['presentation:publish', 'subject:create'])
    await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'curator', action);
  for (const action of ['context:create', 'space:create', 'realm:create'])
    await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'curator', action);
  for (const action of ['subject:merge', 'gate:subject_identity'])
    await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'curator', action);
  await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'reader', 'realm:read');
  const created = await call('/v1/subjects', { type: 'schema:Book', labels: { en: 'Captured book' } });
  expect(created.response.status, JSON.stringify(created.body)).toBe(201);
  subject = created.body.subject.id;
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});

test('unpublished routes and exact companion views use the native result without profile, head or receipt writes', async () => {
  const before = await storage();
  const profile = candidate();
  for (const [target, selected] of [
    [{ route: '/captured' }, document('Unpublished route')],
    [{ subject, view: 'details' }, document('Unpublished companion')],
  ] as const) {
    const answer = await preview(profile, target);
    expect(answer.response.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.response.headers.get('cache-control')).toBe('private, no-store');
    expect(answer.body).toMatchObject({
      profile: profileDigest(profile),
      document: selected,
      draft: { digest: profileDigest(profile), target, advice: 'allowed' },
    });
    expect(answer.body).not.toHaveProperty('head');
  }
  expect(await storage()).toEqual(before);
});

test('a subject source runs anonymously while supported composition siblings remain present', async () => {
  const profile = candidate();
  profile.generic = {
    root: { props: {} },
    content: [{ type: 'SubjectHeader', props: { id: 'native-header' } }, ...document('Captured sibling').content],
  };
  const first = access.readChecks.length;
  const answer = await preview(profile, { subject });
  expect(answer.response.status, JSON.stringify(answer.body)).toBe(200);
  expect(answer.body.document).toEqual(profile.generic);
  expect(answer.body.reads.r0).toMatchObject({ status: 200, body: { subject: { id: subject } } });
  const sources = access.readChecks.slice(first).filter((check) => check.action === 'subject:read');
  expect(sources.length).toBeGreaterThan(0);
  expect(sources.every((check) => check.persona === 'anonymous')).toBe(true);
});

test('captured preview returns the current merged subject while its witness retains the requested identity', async () => {
  const ids: string[] = [];
  for (const label of ['Canonical preview identity', 'Retired preview identity']) {
    const created = await call('/v1/subjects', { type: 'schema:Book', labels: { en: label } });
    expect(created.response.status, JSON.stringify(created.body)).toBe(201);
    ids.push(created.body.subject.id as string);
  }
  ids.sort();
  const [current, requested] = ids as [string, string];
  const merged = await call('/v1/subjects:merge', { subjects: ids });
  expect(merged.response.status, JSON.stringify(merged.body)).toBe(200);

  const answer = await preview(candidate(), { subject: requested });
  expect(answer.response.status, JSON.stringify(answer.body)).toBe(200);
  expect(answer.body.subject).toBe(current);
  expect(answer.body.draft).toEqual({
    digest: profileDigest(candidate()),
    target: { subject: requested },
    advice: 'allowed',
  });
});

test('a failing native leaf retains its supported sibling and captured document', async () => {
  const captured: CompositionDocument = {
    root: { props: {} },
    content: [
      { type: 'SubjectHeader', props: { id: 'header' } },
      { type: 'SubjectList', props: { id: 'authors', title: { en: 'Authors' }, property: 'schema:author', limit: 6 } },
      { type: 'Heading', props: { id: 'sibling', text: { en: 'Supported sibling' }, level: 2 } },
    ],
  };
  const profile: PresentationProfile = { format: PROFILE_FORMAT, generic: captured, bases: [], types: [], routes: [] };
  failLinks = true;
  let answer: Awaited<ReturnType<typeof preview>>;
  try {
    answer = await preview(profile, { subject });
  } finally {
    failLinks = false;
  }
  expect(answer!.response.status, JSON.stringify(answer!.body)).toBe(200);
  expect(answer!.body.document).toEqual(captured);
  expect(Object.values(answer!.body.reads).map((read: any) => read.status)).toContain(503);
  expect(Object.values(answer!.body.reads).map((read: any) => read.status)).toContain(200);
});

test('captured Realm preview cannot return the prior Context disclosure after replacement during a leaf read', async () => {
  const contextA = await makeContext('Captured Realm Context A');
  const contextB = await makeContext('Captured Realm Context B');
  await adoptUrlInContext(contextA, 'https://example.test/captured-context-a');
  await adoptUrlInContext(contextB, 'https://example.test/captured-context-b');
  const realm = await makeRealm(contextA);
  await publishToRealm(realm.realmId, subject);
  const captured: CompositionDocument = {
    root: { props: {} },
    content: [
      { type: 'SubjectHeader', props: { id: 'header' } },
      { type: 'SubjectList', props: { id: 'authors', title: { en: 'Authors' }, property: 'schema:author', limit: 6 } },
      { type: 'Heading', props: { id: 'sibling', text: { en: 'Captured Realm sibling' }, level: 2 } },
    ],
  };
  const profile: PresentationProfile = { format: PROFILE_FORMAT, generic: captured, bases: [], types: [], routes: [] };
  let announce!: () => void;
  let resume!: () => void;
  const observed = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const release = new Promise<void>((resolve) => {
    resume = resolve;
  });
  pausedLinks = { context: contextA, reached: announce, release, used: false };
  const pending = preview(profile, { subject, realm: realm.realmId });
  try {
    const first = await Promise.race([
      observed.then(() => ({ kind: 'observed' as const })),
      pending.then((answer) => ({ kind: 'finished' as const, answer })),
    ]);
    if (first.kind === 'finished')
      expect(first.answer.response.status, JSON.stringify(first.answer.body)).toBe(200);
    else expect(pausedLinks.used).toBe(true);
    const moved = await call(
      `/v1/realms/${realm.realmId}`,
      { contextId: contextB, title: 'Captured Realm Context B current' },
      'curator',
      'PATCH',
      { 'if-match': JSON.stringify(realm.headRevisionId) },
    );
    expect(moved.response.status, JSON.stringify(moved.body)).toBe(200);
    resume();
    const answer = first.kind === 'observed' ? await pending : first.answer;
    if (answer.response.status === 200) {
      const body = JSON.stringify(answer.body);
      expect(body).toContain('captured-context-b');
      expect(body).not.toContain('captured-context-a');
    } else {
      expect(answer.response.status).toBe(503);
      expect(answer.body).not.toHaveProperty('reads');
      expect(answer.body).not.toHaveProperty('context');
    }
    const current = await preview(profile, { subject, realm: realm.realmId });
    expect(current.response.status, JSON.stringify(current.body)).toBe(200);
    expect(JSON.stringify(current.body)).toContain('captured-context-b');
    expect(JSON.stringify(current.body)).not.toContain('captured-context-a');
  } finally {
    resume();
    await pending;
    pausedLinks = null;
  }
});

test('denied, invalid, oversized and unsupported candidates execute no subject source', async () => {
  const profile = candidate();
  const first = access.readChecks.length;
  expect((await preview(profile, { subject }, 'reader')).response.status).toBe(403);
  expect([401, 403]).toContain((await preview(profile, { subject }, null)).response.status);
  expect((await preview({ ...profile, format: 'invalid' }, { subject })).response.status).toBe(400);
  expect(
    (await preview({ ...profile, generic: document('x'.repeat(MAX_PROFILE_BYTES)) }, { subject })).response.status,
  ).toBe(400);
  const unsupported = await preview(profile, { route: '/unknown' });
  expect(unsupported.response.status).toBe(400);
  expect(unsupported.body.errors).toContainEqual({ pointer: '/target/route', code: 'unsupported' });
  const injected = await call('/v1/pages:previewDraft', { profile, target: { subject }, reads: {} });
  expect(injected.response.status).toBe(400);
  expect(access.readChecks.slice(first).filter((check) => check.action === 'subject:read')).toEqual([]);
});
