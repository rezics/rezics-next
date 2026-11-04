import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { MAX_PROFILE_BYTES, PROFILE_FORMAT, profileDigest, type PresentationProfile } from '@rezics/composition';
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
const access = await createRealAccess(admin, { curator: newId(0), reader: newId(0) }, [
  'presentation:read',
  'presentation:publish',
  'presentation:activate',
  'subject:create',
]);
const kernel = createKernel({
  pool,
  access: access.access,
  writeRate: access.writeRate,
  routeKey: new Uint8Array(32).fill(6),
  receiptKeys: testReceiptKeys(),
  requestDeadlineMs: 30_000,
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
async function call(path: string, body: unknown, persona: 'curator' | 'reader' | null = 'curator') {
  const headers = new Headers({ 'content-type': 'application/json', 'idempotency-key': JSON.stringify(randomUUID()) });
  if (persona) headers.set('authorization', `Bearer ${access.bearer(persona)}`);
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
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
