import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { CommandUnavailableError } from '../../src/command/command.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { assertGrowthAccessPaths, capture, checkGrowth, costOf, seed } from '../support/growth.ts';
import { observeSql, type SqlExecution } from './support/sql-observer.ts';
import {
  editionDraftFixture, editionScales, type Draft, type EditionAxis, type EditionDraftFixture,
} from './support/growth-edition-draft-fixture.ts';

const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;
const axes: readonly EditionAxis[] = ['editions/posts', 'selected revisions', 'subject/grant history'];

function assertNativeBoundary(f: EditionDraftFixture, records: readonly SqlExecution[]) {
  const sourceReads = records.filter(({ statement }) => /JOIN editorial\.write_basis w/.test(statement));
  expect(sourceReads.length).toBeGreaterThanOrEqual(3);
  for (const read of sourceReads) {
    expect(read.parameters).toEqual([f.route, f.source.id, f.source.revisionId, f.partition, f.target]);
    expect(read.statement).toContain('r.body_sha256=sha256(r.body)');
    expect(read.statement).toContain('ANY(r.subject_ids)');
  }
  // These are actual driver calls, including ordinary Access and final validation.
  const statements = records.map(({ statement }) => statement).join('\n');
  for (const relation of ['semantic.subject', 'content.board', 'community.realm', 'community.space',
    'access.account', 'content.erasure_fence', 'content.post', 'content.revision',
    'access.resource_initialization', 'access.resource_role_grant', 'core.receipt', 'core.outbox'])
    expect(statements).toContain(relation);
  expect(records.filter(({ statement }) => /FROM access\.account a WHERE/.test(statement)).length)
    .toBeGreaterThanOrEqual(2);
  expect(statements).toContain('INSERT INTO content.edition');
  expect(statements).not.toMatch(/INSERT INTO content\.edition_publication/);
}

async function assertCommitted(f: EditionDraftFixture, draft: Draft, key: string) {
  expect(draft.editionRevision).toBe('1');
  const rows = (await f.db.admin.query(`SELECT * FROM content.edition WHERE route=$1 AND edition_id=$2`,
    [f.route, draft.editionId])).rows;
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  expect(row).toMatchObject({
    state: 'draft', target_subject_id: f.target, creator_account_id: f.native.actors.author.actor.accountId,
    thread_id: f.thread.id, post_id: f.source.id, revision_id: f.source.revisionId,
    licence: 'CC0-1.0', security_revision: '1',
  });
  expect(row.body_sha256.toString('hex')).toBe(f.source.sha256);
  for (const forbidden of ['body', 'file', 'url']) expect(row).not.toHaveProperty(forbidden);
  const initialization = (await f.db.admin.query(`SELECT * FROM access.resource_initialization
    WHERE route=$1 AND resource_id=$2`, [f.route, draft.editionId])).rows;
  expect(initialization).toHaveLength(1);
  expect(initialization[0]).toMatchObject({ resource_type: 'content.edition', creator_id: row.creator_account_id });
  const roles = (await f.db.admin.query(`SELECT * FROM access.resource_role_grant
    WHERE route=$1 AND resource_id=$2`, [f.route, draft.editionId])).rows;
  expect(roles).toHaveLength(1);
  expect(Object.values(roles[0]!)).toContain('content.edition.owner');
  expect(Object.values(roles[0]!)).toContain(row.creator_account_id);
  const evidence = await f.evidence(key);
  expect(evidence.receipts).toHaveLength(1);
  expect(evidence.receipts[0]).toMatchObject({
    partition_no: f.partition, transaction_id: row.recorded_transaction_id, command_kind: 'content.edition.create',
  });
  expect(evidence.events).toHaveLength(1);
  expect(evidence.events[0]).toMatchObject({
    type: 'com.rezics.content.edition.created.v1', subject: draft.editionId, data: draft,
    position: evidence.receipts[0]!.position,
  });
  const metadata = await f.call(`/v1/contentEditions/${draft.editionId}`);
  expect(metadata.status).toBe(200);
  expect(metadata.value).toEqual({ ...draft, state: 'draft', targetSubjectId: f.target,
    creatorAccountId: row.creator_account_id, revisionId: f.source.revisionId,
    sha256: f.source.sha256, licence: 'CC0-1.0' });
}

for (const axis of axes) {
  test(`Edition draft creation: independent ${axis} growth at three native scales`, async () => {
    const f = await editionDraftFixture();
    const observer = observeSql(f.db.pool);
    try {
      const pinned = await f.sourceState();
      const runs: { key: string; draft: Draft }[] = [];
      const footprints: Record<string, number>[] = [];
      const report = await checkGrowth(f.db, {
        name: `Edition draft creation / ${axis} / native HTTP and Access`,
        scales: editionScales, bounds, rule: 'series',
        async grow(db, scale, previous) {
          if (axis === 'selected revisions') await f.growRevisions(scale);
          else await seed(db, f.populations[axis], { from: previous, to: scale });
          footprints.push({ scale, ...await f.footprint() });
        },
        async operation() {
          const key = randomUUID();
          const start = observer.records.length;
          const result = await f.call('/v1/contentEditions', f.input, { key });
          expect({ status: result.status, error: result.status === 201 ? null : result.value })
            .toEqual({ status: 201, error: null });
          expect(routeOf(result.value.editionId)).toBe(f.route);
          assertNativeBoundary(f, observer.records.slice(start));
          runs.push({ key, draft: result.value as Draft });
        },
      });
      expect(report.samples.map(({ scale }) => scale)).toEqual([...editionScales]);
      for (const footprint of footprints) {
        if (axis === 'editions/posts') {
          expect(footprint.editions!).toBeGreaterThanOrEqual(footprint.scale!);
          expect(footprint.posts!).toBe(footprint.scale! + 2);
          expect(footprint.revisions).toBe(2);
        } else if (axis === 'selected revisions') {
          expect(footprint.revisions).toBe(footprint.scale! + 1);
          expect(footprint.posts).toBe(2);
        } else {
          expect(footprint.subjects!).toBeGreaterThanOrEqual(footprint.scale!);
          expect(footprint.subject_history).toBe(footprint.scale! + 1);
          expect(footprint.grants).toBe(footprint.scale);
          expect(footprint.posts).toBe(2);
          expect(footprint.revisions).toBe(2);
        }
      }
      const relations = ['content.post', 'content.revision', 'content.edition', 'editorial.write_basis',
        'semantic.subject', 'content.board', 'community.realm', 'community.space', 'access.account',
        'access.resource_grant', 'access.resource_initialization', 'access.resource_role_grant',
        'core.receipt', 'core.outbox'];
      for (const sample of report.samples) for (const cost of sample.repetitions) {
        expect(cost.rows).toBeGreaterThan(0);
        expect(cost.sharedHit + cost.sharedRead).toBeGreaterThan(0);
        for (const relation of relations) expect(cost.relations[relation], relation).toBeDefined();
      }
      assertGrowthAccessPaths(report.name, report.samples, relations);
      // All administrative outcome checks are outside the observed operation.
      for (const run of runs) await assertCommitted(f, run.draft, run.key);
      const current = await f.sourceState();
      expect(current.head_revision_id).not.toBe(f.source.revisionId);
      const { head_revision_id: _oldHead, ...oldRevision } = pinned;
      const { head_revision_id: _newHead, ...selectedRevision } = current;
      expect(selectedRevision).toEqual(oldRevision);
      console.info(JSON.stringify({ report, footprints, source: f.input, ancestryPosts: 2,
        envelope: 'Native HTTP authentication, source preparation/final guards, command, owner grants, receipt/outbox; no worker' }));
    } finally {
      try { await observer.close(); } finally { await f.close(); }
    }
  }, 1_800_000);
}

test('Edition draft native replay, selected-subject refusals and rollback preserve the pinned source and grants', async () => {
  const f = await editionDraftFixture();
  const observer = observeSql(f.db.pool);
  try {
    const key = randomUUID();
    const created = await capture(f.db, () => f.call('/v1/contentEditions', f.input, { key }), { includeBackends: true });
    expect(created.value.status).toBe(201);
    await assertCommitted(f, created.value.value as Draft, key);
    const before = await f.effects();
    const replay = await capture(f.db, () => f.call('/v1/contentEditions', f.input, { key }), { includeBackends: true });
    expect(replay.value.status).toBe(201);
    expect(replay.value.value).toEqual(created.value.value);
    expect(await f.effects()).toEqual(before);
    const refused = [
      { input: { postId: f.source.id, revisionId: f.source.revisionId }, status: 400 },
      // This association exists on the newer head, never on the pinned original.
      { input: { ...f.input, targetSubjectId: f.scheme }, status: 404 },
      { input: { ...f.input, targetSubjectId: newId(routeOf(f.target)!) }, status: 404 },
    ];
    const captures = [created, replay];
    for (const refusal of refused) {
      const deniedKey = randomUUID();
      const denied = await capture(f.db, () => f.call('/v1/contentEditions', refusal.input, { key: deniedKey }),
        { includeBackends: true });
      expect(denied.value.status).toBe(refusal.status);
      if (refusal.status === 404) expect(denied.value.value).toMatchObject({ code: 'not_found', retryable: false });
      expect(await f.evidence(deniedKey)).toEqual({ receipts: [], events: [] });
      expect(await f.effects()).toEqual(before);
      captures.push(denied);
    }
    const foreign = await capture(f.db, () => f.call('/v1/contentEditions', f.input,
      { bearer: f.native.actors.other.bearer }), { includeBackends: true });
    expect(foreign.value.status).toBe(404);
    expect(await f.effects()).toEqual(before);
    captures.push(foreign);
    // Fault after native owner initialization: rollback must remove the edition AND its grants.
    const insert = observer.records.find(({ statement }) => /INSERT INTO access\.resource_role_grant/.test(statement));
    expect(insert).toBeDefined();
    observer.armFault({ match: { statement: insert!.statement }, boundary: 'after',
      error: new CommandUnavailableError('overloaded', f.partition) });
    const failedKey = randomUUID();
    const rollback = await capture(f.db, () => f.call('/v1/contentEditions', f.input, { key: failedKey }),
      { includeBackends: true });
    expect(rollback.value.status).toBe(503);
    expect(rollback.value.value).toMatchObject({ code: 'overloaded', retryable: true });
    expect(await f.evidence(failedKey)).toEqual({ receipts: [], events: [] });
    expect(await f.effects()).toEqual(before);
    captures.push(rollback);
    // Same failed key is still usable by the genuine command after the one-shot fault.
    const control = await capture(f.db, () => f.call('/v1/contentEditions', f.input, { key: failedKey }),
      { includeBackends: true });
    expect(control.value.status).toBe(201);
    await assertCommitted(f, control.value.value as Draft, failedKey);
    captures.push(control);
    // Draft owner metadata authority does not make bytes deliverable or grant another account source access.
    expect((await f.call(`/v1/contentEditions/${control.value.value.editionId}/revision`)).status).toBe(404);
    expect((await f.call(`/v1/posts/${f.source.id}`, undefined, { bearer: f.native.actors.other.bearer })).status).toBe(404);
    console.info(JSON.stringify({ name: 'Edition draft native command envelope and controls',
      captures: captures.map(({ capture: raw }) => ({ cost: costOf(raw), raw })) }));
  } finally {
    try { await observer.close(); } finally { await f.close(); }
  }
}, 120_000);
