import { afterAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { Value } from 'typebox/value';
import { openApiDocument } from '../../src/http/openapi.ts';
import { AuthenticationError, type AccountActor } from '../../src/request/access.ts';
import {
  ModerationDirectoryPageSchema,
  ModerationDirectoryQuerySchema,
  moderationDirectoryPageIssues,
  type ModerationDirectoryPage,
} from '../../src/content/moderation-directory-schemas.ts';
import { readNativeModerationDirectory } from '../../src/content/moderation-directory.ts';
import { testKernel } from '../support/test-kernel.ts';

const now = Date.parse('2026-11-04T00:00:00Z');
const catalogue = {
  scope: { kind: 'catalogue' },
  label: 'Catalogue',
  parent: null,
  queues: ['reports', 'resolved'],
  viewer: { open: 'permitted' },
};
const ready = { state: 'ready', items: [catalogue], next: null, source: 'opaque', validUntil: new Date(now + 1000).toISOString() };
const unavailable = { state: 'unavailable', items: [], next: null } satisfies ModerationDirectoryPage;
const actor: AccountActor = {
  kind: 'account', accountId: 'account', clientId: 'web', scopes: ['account:read'], requestedBy: null, authnEpoch: 1,
};

test('unknown coverage stays unavailable for initial, filtered and continuation reads', async () => {
  for (const input of [{ limit: 20 }, { limit: 1, realmId: 'realm', cursor: 'original-frontier' }])
    expect(await readNativeModerationDirectory(actor, input)).toEqual(unavailable);
  await expect(readNativeModerationDirectory({ kind: 'anonymous' }, { limit: 20 })).rejects.toBeInstanceOf(AuthenticationError);
  await expect(readNativeModerationDirectory(actor, { limit: 21 })).rejects.toBeInstanceOf(RangeError);
});

test('public advice distinguishes sparse continuation and complete empty from unavailable', () => {
  for (const page of [ready, unavailable, { ...ready, items: [] }, { ...ready, items: [], next: 'frontier' }])
    expect(moderationDirectoryPageIssues(page, now)).toEqual([]);
  for (const state of ['preparing', 'denied', 'stale'])
    expect(moderationDirectoryPageIssues({ ...unavailable, state }, now)).toEqual([]);
  for (const page of [
    { ...unavailable, items: [catalogue] }, { ...unavailable, next: 'frontier' }, { ...unavailable, source: 'private' },
    { ...ready, items: [{ ...catalogue, queues: ['appeals'] }] },
    { ...ready, items: [{ ...catalogue, parent: { id: 'realm', label: 'Realm' } }] },
    { ...ready, items: [{ ...catalogue, reporterId: 'private' }] },
    { ...ready, items: [catalogue, catalogue] }, { ...ready, validUntil: new Date(now).toISOString() },
    { ...ready, validUntil: new Date(now + 180_001).toISOString() },
    { ...ready, next: 'x'.repeat(4097) }, { ...ready, source: 'x'.repeat(257) },
  ]) expect(moderationDirectoryPageIssues(page, now).length).toBeGreaterThan(0);
  const boards = Array.from({ length: 20 }, (_, id) => ({ ...catalogue, scope: { kind: 'board', id: String(id) }, queues: ['reports', 'appeals', 'resolved'] }));
  expect(moderationDirectoryPageIssues({ ...ready, items: boards }, now)).toEqual([]);
  expect(Value.Check(ModerationDirectoryPageSchema, { ...ready, items: [...boards, catalogue] })).toBe(false);
  expect(Value.Check(ModerationDirectoryQuerySchema, { limit: '20', cursor: 'x'.repeat(4096) })).toBe(true);
  for (const query of [{ limit: '21' }, { cursor: '' }, { cursor: 'x'.repeat(4097) }, { queueCursor: 'other' }])
    expect(Value.Check(ModerationDirectoryQuerySchema, query)).toBe(false);
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
test('native mounted source is an authenticated public publisher input', async () => {
  const app = testKernel({ pool });
  const operation = openApiDocument(app).paths['/v1/me/moderation-directory']?.get;
  expect(operation).toMatchObject({ operationId: 'moderation.directory', 'x-exposure': 'public', 'x-action': 'account:read', security: [{ bearerAuth: [] }] });
  expect(operation?.responses?.['200']).toBeDefined();
  const response = await app.handle(new Request('http://kernel.test/v1/me/moderation-directory'));
  expect(response.status).toBe(401);
});
