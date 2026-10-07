import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { baselineTarget } from '../src/modules/access/baseline.ts';
import { receiptFamilyFor } from '../src/modules/access/receipt-families.ts';
import { resourceSummary } from '../src/modules/media/summary-contract.ts';
import { discoverOutboxEventHandlers } from '../src/modules/outbox/event-handlers.ts';
import { MAX_FRAMES, MAX_PAGE, PROJECTION_COST, PROJECTION_FAMILY, PROJECTION_SCOPE, ProjectionRefused,
  projectionDigest, projectionKey, projectionPage, projectionQuery, projectionRequest, projectionWriteResponse }
  from '../src/modules/projection/schema.ts';
import { AccountAssertionDenied, AccountAssertionInsufficientScope, AccountAssertionUnavailable }
  from '../src/modules/account/verify-assertion.ts';
import { verifyProjectionWriter } from '../src/modules/projection/command.ts';
import { openApiOperations } from '../src/routes/projections.ts';
import { projectionFrameListSql } from '../src/modules/projection/store.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [subject, a, b, c] = [id(1), id(2), id(3), id(4)];

test('the key of a subject and frame set is order-free and the hash the Access table checks', () => {
  const key = projectionKey(subject, [c, a, b]);
  expect(key.frames).toEqual([a, b, c]);
  expect(projectionKey(subject, [b, c, a]).key).toBe(key.key);
  expect(key.key).toBe(createHash('sha256').update(`${subject}\n${a}\n${b}\n${c}`).digest('hex'));
  // Subject and frames are not interchangeable, and a subset or another subject is another identity.
  const keys = [key, projectionKey(subject, [a, b]), projectionKey(a, [subject, b, c])].map(item => item.key);
  expect(new Set(keys).size).toBe(3);
  expect(projectionDigest(key, id(9))).not.toBe(projectionDigest(key, id(8)));
});

test('a malformed frame set is refused before any read', () => {
  const refuse = (...args: Parameters<typeof projectionKey>) => {
    try { projectionKey(...args); } catch (error) { return error; }
    throw new Error('expected a refusal');
  };
  const frames = Array.from({ length: MAX_FRAMES + 1 }, (_, index) => id(100 + index));
  for (const error of [refuse(subject, []), refuse(subject, frames), refuse(subject, [a, a]), refuse(subject, [subject, a]),
    refuse('https://example.com/subject', [a]), refuse(subject, ['https://example.com/frame'])]) {
    expect(error).toBeInstanceOf(ProjectionRefused);
    expect(error).toMatchObject({ status: 400, code: 'invalid_projection' });
  }
  expect(projectionKey(subject, frames.slice(0, MAX_FRAMES)).frames).toHaveLength(MAX_FRAMES);
});

test('the request and response contracts are closed and bounded', () => {
  expect(Value.Check(projectionRequest, { subject, frames: [a], actingSubject: id(9) })).toBe(true);
  expect(Value.Check(projectionRequest, { subject, frames: [], actingSubject: id(9) })).toBe(false);
  expect(Value.Check(projectionRequest, { subject, frames: Array.from({ length: 9 }, (_, n) => id(10 + n)), actingSubject: id(9) })).toBe(false);
  expect(Value.Check(projectionRequest, { subject, frames: [a], actingSubject: id(9), extra: 1 })).toBe(false);
  expect(Value.Check(projectionRequest, { subject, frames: [a] })).toBe(false);
  const view = { id: id(5), subject, frames: [a, b], revision: id(6), disclosure: 'public' };
  const position = { dataEpoch: 'epoch', sequence: '4' };
  expect(Value.Check(projectionWriteResponse, { projection: view, created: true, replayed: false,
    sourcePosition: { datasetId: 'product', ...position } })).toBe(true);
  expect(Value.Check(projectionPage, { items: [view], nextCursor: null, sourcePosition: position })).toBe(true);
  expect(Value.Check(projectionPage, { items: Array.from({ length: MAX_PAGE + 1 }, () => view), nextCursor: null,
    sourcePosition: position })).toBe(false);
  expect(Value.Check(projectionPage, { items: [{ ...view, disclosure: 'private' }], nextCursor: null, sourcePosition: position })).toBe(false);
});

test('frame membership and exact frame-set lookup have distinct bounded contracts', () => {
  for (const query of [{ frame: a }, { subject }, { frame: a, subject, cursor: id(8).slice(-36), limit: 1 },
    { subject, frames: [a, b] }, ...['mine', 'all', 'start', c].map(position => ({ subject, position }))]) {
    expect(Value.Check(projectionQuery, query)).toBe(true);
  }
  for (const query of [{ frame: [a, b] }, { frames: [] }, { frame: a, limit: MAX_PAGE + 1 },
    { frame: a, extra: true }, { frame: a, cursor: a }, { subject, position: 'chapter 3' }]) expect(Value.Check(projectionQuery, query)).toBe(false);
  expect(PROJECTION_COST.listSelectors).toBe(2);
  expect(PROJECTION_COST.identityReadsPerBatch).toBe(1);
  expect(PROJECTION_COST.frameMembershipsPerIdentity).toBe(MAX_FRAMES);
});

test('frame candidate queries seek in order with optional subject and continuation', () => {
  expect(projectionFrameListSql(false, false)).toContain('WHERE frame = $1');
  expect(projectionFrameListSql(false, true)).toContain('AND projection > $2::uuid');
  expect(projectionFrameListSql(true, false)).toContain('AND subject = $2');
  expect(projectionFrameListSql(true, true)).toContain('AND projection > $3::uuid');
  for (const subject of [false, true]) for (const continued of [false, true]) {
    const sql = projectionFrameListSql(subject, continued);
    expect(sql).toContain(`ORDER BY projection LIMIT $${2 + Number(subject) + Number(continued)}`);
    expect(sql).not.toContain(' OR ');
  }
});

test('a summary carries a projection as its subject and frames, each a summary of its own', () => {
  const name = { value: 'Misaka', language: 'en', direction: 'ltr', basis: 'fallback' };
  const part = (reference: string, type = 'work') => ({ reference, status: 'available', type, base: 'work', work: reference,
    address: { prefix: '/w/', key: 'k', suffixSource: 'S' }, disclosure: 'public', name,
    avatar: { kind: 'fallback', policy: 'avatar-fallback-v1', key: 'f', resourceType: type } });
  const projection = { ...part(id(5), 'projection'), base: 'projection', work: null,
    parts: { subject: part(subject), frames: [part(a), part(b)] } };
  expect(Value.Check(resourceSummary, projection)).toBe(true);
  expect(Value.Check(resourceSummary, { ...projection, parts: { subject: part(subject), frames: [] } })).toBe(false);
  expect(Value.Check(resourceSummary, { ...projection, parts: { subject: part(subject),
    frames: Array.from({ length: 9 }, (_, n) => part(id(20 + n))) } })).toBe(false);
  // Parts do not nest: a part has no parts, no resolution and no unknown field.
  expect(Value.Check(resourceSummary, { ...projection, parts: { subject: { ...part(subject), parts: projection.parts },
    frames: [part(a)] } })).toBe(false);
  expect(Value.Check(resourceSummary, { reference: id(5), status: 'unavailable', parts: projection.parts })).toBe(false);
});

test('any admitted Person creates a projection under one root scope and its receipts are discoverable', async () => {
  expect(baselineTarget('projection.create', PROJECTION_SCOPE)).toEqual({ kind: 'root' });
  for (const [action, scope] of [['projection.create', `projection:create:${subject}`], ['projection.create', 'work:create:root'],
    ['projection.edit', PROJECTION_SCOPE], ['projection.create', `${PROJECTION_SCOPE}:extra`], ['work.create', PROJECTION_SCOPE]] as const) {
    expect(baselineTarget(action, scope), `${action} ${scope}`).toBeNull();
  }
  expect(receiptFamilyFor('projection.create')).toBe(PROJECTION_FAMILY);
  const handlers = [...(await discoverOutboxEventHandlers()).values()].filter(handler => handler.action === 'projection.create');
  expect(handlers.map(handler => handler.type).sort()).toEqual(['com.rezics.projection.create-cancelled.v1',
    'com.rezics.projection.create-stale.v1', 'com.rezics.projection.created.v1']);
  expect(openApiOperations['/v1/projections']).toEqual({ post: { rateLimitFamily: 'write', exposure: 'public', bearer: true, idempotencyKey: true }, get: { rateLimitFamily: 'read', exposure: 'public', bearer: false } });
});

test('the cost contract holds for the largest page, whatever exists about the subject', () => {
  expect(PROJECTION_COST.partsPerProjection).toBe(MAX_FRAMES + 1);
  expect(PROJECTION_COST.listPage).toBe(MAX_PAGE);
  // A full candidate batch, including disclosed lookahead, still fits three part pages of 64.
  expect(PROJECTION_COST.listLookahead).toBe(1);
  expect(PROJECTION_COST.partPagesPerListPage).toBe(Math.ceil((MAX_PAGE + 1) * (MAX_FRAMES + 1) / 64));
  expect(PROJECTION_COST.partPagesPerListPage).toBe(3);
  expect(PROJECTION_COST.revelationBatchesPerListPage).toBe(5);
  expect(PROJECTION_COST.creationWrites.graphCommands).toBe(1);
});


test('projection writers need any existing judgment consent, including review and both reply paths', async () => {
  const request = new Request('http://main.local/v1/projections');
  const principal = { issuer: 'https://account.test', subject: 'writer' };
  for (const granted of ['rating:submit', 'comment:create', 'work:edit'] as const) {
    const checked: string[][] = [];
    const account = { verify: async (_request: Request, required: readonly string[]) => {
      checked.push([...required]);
      if (required.some(scope => scope !== granted)) throw new AccountAssertionInsufficientScope();
      return principal;
    } };
    expect(await verifyProjectionWriter(account, request)).toEqual({ principal, scope: granted });
    expect(checked.at(-1)).toEqual([granted]);
    expect(checked.length).toBeLessThanOrEqual(PROJECTION_COST.writerScopeChecks);
  }
  const refused = new AccountAssertionInsufficientScope('Account assertion lacks a required scope');
  let checks = 0;
  await expect(verifyProjectionWriter({ verify: async () => { checks++; throw refused; } }, request))
    .rejects.toBe(refused);
  expect(checks).toBe(PROJECTION_COST.writerScopeChecks);
  for (const error of [new AccountAssertionDenied(), new AccountAssertionUnavailable()]) {
    checks = 0;
    await expect(verifyProjectionWriter({ verify: async () => { checks++; throw error; } }, request)).rejects.toBe(error);
    expect(checks).toBe(1);
  }
});
