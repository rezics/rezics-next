import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { randomUUID } from 'node:crypto';
import { createReportEffect } from '../../src/content/report-effect.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { createReactionRelayBase, type ReactionRelayBase } from './reaction-relay-convergence-fixture.ts';

let fixture: ReactionRelayBase;
beforeAll(async () => {
  fixture = await createReactionRelayBase();
}, 60_000);
afterAll(async () => {
  await fixture?.system.close();
});

async function grant(id: string, action: string) {
  const input = {
    resource: { route: routeOf(id)!, id },
    subject: { kind: 'account', id: fixture.other.accountId },
    actions: [action],
    valid: '(,)',
  };
  const result = await fixture.command<{ grant: { valid: string } }>('POST', '/v1/grants', input, {
    bearer: fixture.governance.bearer,
  });
  return { ...input, valid: result.grant.valid };
}

async function report(postId: string, revisionId: string) {
  const key = randomUUID();
  const result = await fixture.command<{ reportId: string }>(
    'POST',
    '/v1/reports',
    {
      target: { kind: 'post', id: postId },
      revisionId,
      reason: 'other',
      evidence: 'Submitted evidence',
    },
    { bearer: fixture.author.bearer, key },
  );
  const partition = partitionOf(routeOf(result.reportId)!);
  const receipt = await fixture.system.database.pool.query<{ epoch: number; position: string }>(
    `SELECT epoch, position::text FROM core.receipt
     WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
       AND command_kind='content.report.create' AND idempotency_key=$3`,
    [partition, fixture.author.accountId, key],
  );
  expect(receipt.rows).toHaveLength(1);
  const row = receipt.rows[0]!;
  const outbox = await fixture.system.database.pool.query<{ id: string; type: string; data: unknown; time: string }>(
    `SELECT id,type,data,recorded_at::text AS time FROM core.outbox WHERE partition_no=$1 AND epoch=$2 AND position=$3 AND event_seq=0`,
    [partition, row.epoch, row.position],
  );
  expect(outbox.rows).toHaveLength(1);
  const source = outbox.rows[0]!;
  const event: CloudEvent = {
    specversion: '1.0',
    id: source.id,
    source: `urn:rezics:log:${partition}.${row.epoch}`,
    type: source.type,
    subject: result.reportId,
    time: source.time,
    datacontenttype: 'application/json',
    sequence: row.position.padStart(19, '0'),
    data: source.data,
  };
  const effect = createReportEffect(fixture.system.database.pool);
  expect(effect.name).toBe('content_report_target');
  await effect.run(event);
  await effect.run(event);
  return result.reportId;
}

async function queue(path: string) {
  const result = await fixture.call('GET', path, { bearer: fixture.other.bearer });
  expect(result.response.status).toBe(200);
  return result;
}

test('a post report reaches its board, keeps exact lists and disappears on current target authority loss', async () => {
  const target = await fixture.createThread(fixture.mainBoardId, 'Board queue report');
  const read = await fixture.call('GET', `/v1/posts/${target.postId}`);
  expect(read.response.status).toBe(200);
  await grant(target.boardId, 'moderation:read_reports');
  const permission = await grant(target.postId, 'moderation:read_reports');
  const first = await report(target.postId, read.value!.post.revisionId);
  const second = await report(target.postId, read.value!.post.revisionId);
  const board = await queue(`/v1/boards/${target.boardId}/reports?limit=1`);
  expect(board.value!.reports.map((entry: { id: string }) => entry.id)).toEqual([second]);
  expect(board.value!.next).toBeString();
  const next = await queue(
    `/v1/boards/${target.boardId}/reports?limit=1&cursor=${encodeURIComponent(board.value!.next)}`,
  );
  expect(next.value!.reports.map((entry: { id: string }) => entry.id)).toEqual([first]);
  const exact = await queue(`/v1/posts/${target.postId}/reports`);
  expect(exact.value!.reports.map((entry: { id: string }) => entry.id)).toEqual([second, first]);
  await grant(target.threadId, 'moderation:read_reports');
  expect((await queue(`/v1/threads/${target.threadId}/reports`)).value!.reports).toEqual([]);

  await fixture.command('POST', '/v1/grants:revoke', permission, { bearer: fixture.governance.bearer });
  const denied = await queue(`/v1/boards/${target.boardId}/reports?limit=1`);
  expect(denied.value!.reports).toEqual([]);
  expect(denied.value!.next).toBeString();
  expect(denied.text).not.toContain(second);
  expect(denied.text).not.toContain('Submitted evidence');
  const deniedNext = await queue(
    `/v1/boards/${target.boardId}/reports?limit=1&cursor=${encodeURIComponent(denied.value!.next)}`,
  );
  expect(deniedNext.value).toEqual({ reports: [], next: null });
}, 60_000);

test('an edited reported post retains its original readable revision and accepts one native-sized decision reason', async () => {
  const target = await fixture.createThread(fixture.mainBoardId, 'Edited report target');
  const original = await fixture.call('GET', `/v1/posts/${target.postId}`);
  expect(original.response.status).toBe(200);
  await grant(target.boardId, 'moderation:read_reports');
  await grant(target.postId, 'moderation:read_reports');
  await grant(target.postId, 'moderation:takedown');
  const revisionId: string = original.value!.post.revisionId;
  const reportId = await report(target.postId, revisionId);
  await fixture.command(
    'POST',
    `/v1/posts/${target.postId}/revisions`,
    {
      body: fromPlainText('Readable current target after editing'),
      licence: 'MIT',
      subjectIds: [fixture.conceptId],
    },
    { bearer: fixture.author.bearer, expectedStatus: 200 },
  );
  const board = await queue(`/v1/boards/${target.boardId}/reports`);
  expect(board.value!.reports.find((entry: { id: string }) => entry.id === reportId)?.revisionId).toBe(revisionId);
  const reported = await fixture.call('GET', `/v1/posts/${target.postId}/revisions/${revisionId}`, {
    bearer: fixture.other.bearer,
  });
  expect(reported.response.status).toBe(200);
  expect(reported.value!.post.body).toEqual(original.value!.post.body);
  const current = await fixture.call('GET', `/v1/posts/${target.postId}`, { bearer: fixture.other.bearer });
  expect(current.value!.post.body).not.toEqual(reported.value!.post.body);
  const key = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    const decision = await fixture.call('POST', `/v1/posts/${target.postId}:takeDown`, {
      bearer: fixture.other.bearer,
      key,
      body: { reason: 'R'.repeat(1024) },
    });
    expect(decision.response.status).toBe(200);
  }
}, 60_000);
