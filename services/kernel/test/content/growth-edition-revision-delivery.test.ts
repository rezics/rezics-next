import { expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { serializeDocument } from '@rezics/document';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { clearErasedPostRevisions } from '../../src/content/erased-post-cleanup.ts';
import { routeOf } from '../../src/route/route.ts';
import { assertGrowthAccessPaths, checkGrowth, type GrowthReport } from '../support/growth.ts';
import {
  deliveryAxes, finalGuardBoundary, growthEditionRevisionDeliveryFixture, permissionExecutions,
  type Selection,
} from './support/growth-edition-revision-delivery-fixture.ts';
import type { SqlExecution } from './support/sql-observer.ts';

setDefaultTimeout(600_000);
const scales = [256, 1024, 4096] as const;
type Fixture = Awaited<ReturnType<typeof growthEditionRevisionDeliveryFixture>>;
const path = (selected: Selection) => `/v1/contentEditions/${selected.editionId}/revision`;
const conditional = (selected: Selection) => ({
  'if-none-match': JSON.stringify(selected.post.sha256), 'if-modified-since': 'Tue, 01 Jan 2097 00:00:00 GMT',
});

async function delivered(f: Fixture, selected = f.selected, owner = false) {
  const response = await f.wire(owner ? f.publisher : f.buyer, path(selected), 'GET', undefined, undefined, conditional(selected));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const value = await response.json();
  expect(value).toEqual(selected.expected);
  const bytes = Buffer.from(serializeDocument(value.body));
  expect(bytes.equals(selected.bytes)).toBe(true);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(value.sha256);
}

async function refused(f: Fixture, selected: Selection, status = 404) {
  for (const headers of [conditional(selected), { 'if-none-match': '*' }]) {
    const response = await f.wire(f.buyer, path(selected), 'GET', undefined, undefined, headers);
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.text()).not.toContain('Pinned canonical edition bytes');
  }
}

function assertGuards(f: Fixture, selected: Selection, records: readonly SqlExecution[]) {
  // Preparation and final native disclosure both evaluate the publisher and the recipient.
  const parents = [
    ['subject:read', f.subjectId], ['board:read', f.boardId], ['realm:read', f.realmId],
    ['space:read', f.spaceId], ['thread:read', selected.threadId],
    ...selected.ancestors.map((id) => ['post:read', id]),
  ] as const;
  for (const [action, id] of parents) {
    for (const person of [f.publisher, f.buyer])
      expect(permissionExecutions(records, person.accountId, action!, id!).length).toBeGreaterThanOrEqual(2);
  }
  for (const [person, action, id] of [
    [f.publisher, 'edition:sell', selected.editionId], [f.publisher, 'post:revise', selected.post.id],
    [f.publisher, 'post:read', selected.post.id], [f.buyer, 'edition:read', selected.editionId],
  ] as const)
    expect(permissionExecutions(records, person.accountId, action, id).length).toBeGreaterThanOrEqual(
      action === 'edition:read' ? 1 : 2,
    );
  // Only the selected post is enrolled; every ancestor keeps its independent buyer check.
  expect(permissionExecutions(records, f.buyer.accountId, 'post:read', selected.post.id)).toEqual([]);
  expect(records.filter((row) => row.statement.includes('FROM content.edition_publication')).length).toBeGreaterThan(1);
  expect(records.filter((row) => row.statement.includes('FROM core.receipt')).length).toBeGreaterThan(1);
  const bodyReads = records.filter((row) => row.statement.trimStart().startsWith('SELECT body FROM content.revision'));
  expect(bodyReads.length).toBe(1);
  expect(bodyReads[0]!.parameters.slice(0, 4)).toEqual([
    routeOf(selected.post.id), selected.threadId, selected.post.id, selected.post.revisionId,
  ]);
}

function assertPhysicalEvidence(report: GrowthReport) {
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  for (const sample of report.samples) {
    expect(sample.cost.rows).toBeGreaterThan(0);
    expect(sample.cost.statements).toBeGreaterThan(0);
    expect(sample.cost.plans).toBeGreaterThan(0);
    expect(sample.cost.blocks).toBe(sample.cost.sharedHit + sample.cost.sharedRead);
    expect(sample.cost.blocks).toBeGreaterThan(0);
    // Auth is instrumented before nativeFixture opens a connection. Its actual current
    // consent and restoration work must be present, beyond kernel DTO/source queries.
    const identities = Object.values(sample.cost.relations).flatMap((row) => row.identity ? [row.identity] : []);
    expect(new Set(identities.map((row) => row.database)).size).toBeGreaterThanOrEqual(2);
  }
  const relations = [...new Set(report.samples.flatMap((sample) => Object.keys(sample.cost.relations)))];
  assertGrowthAccessPaths(report.name, report.samples, relations);
}

for (const axis of deliveryAxes) {
  test(`Edition exact revision delivery growth: ${axis}`, async () => {
    const f = await growthEditionRevisionDeliveryFixture();
    try {
      await f.pinned(f.selected);
      await f.noPostGrant(f.selected);
      expect(f.selected.bytes.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
      expect(f.selected.ancestors.length + 1).toBeLessThanOrEqual(33);
      await delivered(f, f.selected, true); // Native owner control, without a fabricated entitlement.
      const report = await checkGrowth(f.db, {
        name: `Edition exact revision delivery as ${axis} grows`, scales,
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
        async grow(_db, scale, previous) { await f.grow(axis, scale, previous); },
        async operation() {
          const observer = f.observe();
          try {
            await delivered(f);
            assertGuards(f, f.selected, observer.records);
          } finally { await observer.close(); }
        },
      });
      assertPhysicalEvidence(report);
      await f.pinned(f.selected);
      await f.noPostGrant(f.selected);
    } finally { await f.close(); }
  });
}

test('Edition bytes retain parent access, current grants and terminal native source outcomes', async () => {
  const f = await growthEditionRevisionDeliveryFixture();
  try {
    await delivered(f);
    for (const headers of [conditional(f.selected), { 'if-none-match': '*' }]) {
      const response = await f.wire(f.outsider, path(f.selected), 'GET', undefined, undefined, headers);
      expect(response.status).toBe(404); // An edition grant supplies neither protected board nor Realm access.
      expect(await response.text()).not.toContain('Pinned canonical edition bytes');
    }
    expect((await f.wire(null, path(f.selected))).status).toBe(401);
    await f.grant(f.selected.editionId, f.buyer, ['edition:read'], true);
    await refused(f, f.selected);
    await delivered(f, f.selected, true);
    await f.grant(f.selected.editionId, f.buyer, ['edition:read']);
    await delivered(f);
    await f.value(f.wire(f.publisher, `/v1/contentEditions/${f.selected.editionId}:unpublish`, 'POST', {}, '2'), 200);
    await refused(f, f.selected);

    const takenDown = await f.selection();
    await delivered(f, takenDown);
    await f.value(f.wire(f.publisher, `/v1/posts/${takenDown.post.id}:takeDown`, 'POST', { reason: 'Withhold source' }), 200);
    await refused(f, takenDown);

    const erased = await f.selection();
    await delivered(f, erased);
    await f.value(f.wire(f.publisher, `/v1/posts/${erased.post.id}`, 'DELETE'), 200);
    await refused(f, erased);
    // Compose the existing cleanup unchanged, outside the byte-read envelope.
    await clearErasedPostRevisions(f.db.pool, { postId: erased.post.id }, Date.now() + 10_000,
      () => new Date(Date.now() + 31 * 86400000));
    const stored = await f.db.admin.query<{ body: Buffer | null }>(
      'SELECT body FROM content.revision WHERE route=$1 AND revision_id=$2',
      [routeOf(erased.post.id), erased.post.revisionId],
    );
    expect(stored.rows[0]!.body).toBeNull();
    await refused(f, erased);

    const revoked = await f.selection();
    await delivered(f, revoked);
    const role = await f.db.admin.query<{ valid: string }>(
      `SELECT valid::text FROM access.resource_role_grant
       WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND grant_role='content.post.owner'`,
      [routeOf(revoked.post.id), revoked.post.id, f.publisher.accountId],
    );
    await f.value(f.wire(f.publisher, '/v1/roleGrants:revoke', 'POST', {
      resource: { route: routeOf(revoked.post.id), id: revoked.post.id },
      subject: { kind: 'account', id: f.publisher.accountId }, role: 'content.post.owner', valid: role.rows[0]!.valid,
    }), 200);
    await refused(f, revoked, 503); // Native publisher restoration cannot supply post:revise.
  } finally { await f.close(); }
});

test('Edition byte disclosure repeats the buyer grant and protected parent checks after preparation', async () => {
  const f = await growthEditionRevisionDeliveryFixture();
  try {
    for (const [action, id] of [
      ['edition:read', f.selected.editionId], ['board:read', f.boardId], ['realm:read', f.realmId],
    ] as const) {
      const calibration = f.observe();
      await delivered(f);
      const boundary = finalGuardBoundary(calibration.records, f.buyer.accountId, action, id);
      await calibration.close();
      const observer = f.observe();
      const barrier = observer.hold(boundary, 'before');
      const pending = f.wire(f.buyer, path(f.selected), 'GET', undefined, undefined, conditional(f.selected));
      try {
        await Promise.race([barrier.entered, pending.then((response) => {
          throw new Error(`Final native ${action} boundary was not reached: ${response.status}`);
        })]);
        await f.grant(id, f.buyer, [action], true, true);
        barrier.release();
        const response = await pending;
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain('Pinned canonical edition bytes');
      } finally {
        barrier.release();
        await pending;
        await observer.close();
      }
      await f.grant(id, f.buyer, [action]);
      await delivered(f);
    }
  } finally { await f.close(); }
});

test('Edition delivery preserves native source unavailability and its single restoration deadline', async () => {
  const f = await growthEditionRevisionDeliveryFixture();
  try {
    const calibration = f.observe();
    await delivered(f);
    const sourceRead = calibration.records.find((row) => row.statement.includes('FROM content.post p JOIN content.revision r'));
    expect(sourceRead).toBeDefined();
    await calibration.close();
    // These are faults at actual native SQL boundaries, never replacement evaluators or sources.
    for (const error of [Object.assign(new Error('native source unavailable'), { code: '08006' }), new AccessUnavailableError('deadline')]) {
      const observer = f.observe();
      observer.armFault({ match: { statement: sourceRead!.statement }, boundary: 'before', error });
      try {
        const response = await f.wire(f.buyer, path(f.selected), 'GET', undefined, undefined, conditional(f.selected));
        expect(response.status).toBe(503);
        expect(await response.text()).not.toContain('Pinned canonical edition bytes');
      } finally { await observer.close(); }
    }
    const observer = f.observe();
    const barrier = observer.hold({ statement: sourceRead!.statement }, 'before');
    const pending = f.wire(f.buyer, path(f.selected));
    try {
      await Promise.race([barrier.entered, pending.then((response) => {
        throw new Error(`Native source deadline boundary was not reached: ${response.status}`);
      })]);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      barrier.release();
      const response = await pending;
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('Pinned canonical edition bytes');
    } finally {
      barrier.release();
      await pending;
      await observer.close();
    }
    await delivered(f);
  } finally { await f.close(); }
});
