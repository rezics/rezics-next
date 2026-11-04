import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PROFILE_FORMAT, profileDigest, type PresentationProfile } from '@rezics/composition';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { readCurationOpening } from '../../src/presentation/curation-advice.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { createRealAccess } from '../semantic/real-access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const curatorId = randomUUID();
const readerId = randomUUID();
const scopes = ['presentation:publish', 'presentation:activate', 'presentation:read'] as const;
const realAccess = await createRealAccess(admin, { curator: curatorId, reader: readerId }, scopes);
const curatorToken = realAccess.bearer('curator');
const readerToken = realAccess.bearer('reader');
const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(5)]]) };
const profile: PresentationProfile = {
  format: PROFILE_FORMAT,
  generic: { root: { props: {} }, content: [] },
  bases: [],
  types: [],
  routes: [],
};
const digest = profileDigest(profile);
let kernel: ReturnType<typeof createKernel>;

async function call(path: string, token?: string, method = 'GET', body?: unknown) {
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (body !== undefined) {
    headers.set('content-type', 'application/json');
    headers.set('idempotency-key', randomUUID());
  }
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { response, body: (await response.json()) as Record<string, any> };
}

beforeAll(async () => {
  await admin.query(
    `INSERT INTO semantic.context (route, context_id, kind, labels, defaults, recorded_transaction_id)
     VALUES (0, $1, 'global', '{"en":"Global"}'::jsonb, '{}'::jsonb, $2)
     ON CONFLICT (route, context_id) DO NOTHING`,
    [GLOBAL_CONTEXT, randomUUID()],
  );
  for (const action of ['presentation:publish', 'presentation:activate'])
    await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'curator', action);
  kernel = createKernel({
    pool,
    requestDeadlineMs: 30_000,
    access: realAccess.access,
    tokens,
    receiptKeys: testReceiptKeys(),
    routeKey: new Uint8Array(32).fill(6),
    writeRate: { async spend() { return { allowed: true }; } },
  });
  const published = await call('/v1/presentation/profiles', curatorToken, 'POST', { profile });
  expect(published.response.status).toBe(201);
  expect(published.body).toEqual({ digest });
  const activated = await call(`/v1/presentation/profiles/${digest}:activate`, curatorToken, 'POST', { expected_head: null });
  expect(activated.response.status).toBe(200);
});

afterAll(async () => {
  await admin.query('DELETE FROM presentation.profile_activation WHERE route = 0 AND digest = $1', [digest]);
  await admin.query('DELETE FROM presentation.profile WHERE route = 0 AND digest = $1', [digest]);
  for (const action of ['presentation:publish', 'presentation:activate']) {
    await realAccess.revoke({ route: 0, id: GLOBAL_CONTEXT }, 'curator', action);
    await realAccess.revoke({ route: 0, id: GLOBAL_CONTEXT }, 'reader', action);
  }
  await pool.end();
  await admin.end();
});

test('the opening API reports independent native actions and has no command effects', async () => {
  const before = await admin.query(
    'SELECT (SELECT count(*) FROM presentation.profile WHERE digest = $1) AS profiles, (SELECT count(*) FROM presentation.profile_activation WHERE digest = $1) AS activations',
    [digest],
  );

  const anonymous = await call('/v1/presentation/curation');
  expect(anonymous.response.status).toBe(200);
  expect(anonymous.response.headers.get('cache-control')).toBe('private, no-store');
  expect(anonymous.body).toMatchObject({ viewer: 'anonymous', digest, advice: { publish: 'denied', activate: 'denied' } });

  const allowed = await call('/v1/presentation/curation', curatorToken);
  expect(allowed.body).toMatchObject({ viewer: 'account', advice: { publish: 'allowed', activate: 'allowed' } });
  const denied = await call('/v1/presentation/curation', readerToken);
  expect(denied.body).toMatchObject({ viewer: 'account', advice: { publish: 'denied', activate: 'denied' } });

  await realAccess.revoke({ route: 0, id: GLOBAL_CONTEXT }, 'curator', 'presentation:activate');
  expect((await call('/v1/presentation/curation', curatorToken)).body).toMatchObject({
    advice: { publish: 'allowed', activate: 'denied' },
  });
  await realAccess.revoke({ route: 0, id: GLOBAL_CONTEXT }, 'curator', 'presentation:publish');
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'curator', 'presentation:activate');
  expect((await call('/v1/presentation/curation', curatorToken)).body).toMatchObject({
    advice: { publish: 'denied', activate: 'allowed' },
  });
  await realAccess.revoke({ route: 0, id: GLOBAL_CONTEXT }, 'curator', 'presentation:activate');

  const after = await admin.query(
    'SELECT (SELECT count(*) FROM presentation.profile WHERE digest = $1) AS profiles, (SELECT count(*) FROM presentation.profile_activation WHERE digest = $1) AS activations',
    [digest],
  );
  expect(after.rows).toEqual(before.rows);
  const opening = openApiDocument(kernel).paths['/v1/presentation/curation']!.get!;
  expect(opening).toMatchObject({ operationId: 'presentation.read_curation', 'x-action': 'presentation:read' });
  expect(opening.responses!['200']).toBeDefined();
});

test('advice changing during assembly fails closed per action and is not treated as authorization', async () => {
  const actionRow = (publish: boolean) => ({
    resources: [
      {
        type: 'semantic.context',
        id: GLOBAL_CONTEXT,
        viewerActions: [
          ...(publish ? [{ action: 'presentation:publish', operations: ['presentation.publish'] }] : []),
          { action: 'presentation:activate', operations: ['presentation.activate'] },
        ],
      },
    ],
  });
  const rows = [actionRow(true), actionRow(false)];
  let activeReads = 0;
  const opening = await readCurationOpening({
    viewer: 'account',
    readActive: async () => {
      activeReads++;
      return { digest, head: 1 };
    },
    readProfile: async () => profile,
    readViewerActions: async () => rows.shift(),
  });
  expect(activeReads).toBe(2);
  expect(opening).toMatchObject({ state: 'active', advice: { publish: 'unavailable', activate: 'allowed' } });
});
