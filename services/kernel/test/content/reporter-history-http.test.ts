import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { routeOf } from '../../src/route/route.ts';
import { createReporterHistoryFixture } from './support/reporter-history-fixture.ts';

let fixture: Awaited<ReturnType<typeof createReporterHistoryFixture>>;
beforeAll(async () => { fixture = await createReporterHistoryFixture(); }, 120_000);
afterAll(async () => { await fixture?.system.close(); });

test('a signed reporter can return without a receipt URL and cannot enumerate another reporter', async () => {
  const target = await fixture.createThread(fixture.mainBoardId, 'Recognizable reported discussion');
  const id = await fixture.submit({ kind: 'thread', id: target.threadId }, { project: false });
  const unprojected = await fixture.call('GET', `/v1/reports/me?reportId=${id}`, { bearer: fixture.author.bearer });
  expect(unprojected.response.status).toBe(200);
  expect(unprojected.value!.entries.map((entry: any) => entry.id)).toEqual([id]);
  await fixture.project(id);
  const page = await fixture.call('GET', '/v1/reports/me', { bearer: fixture.author.bearer });
  expect(page.response.status).toBe(200);
  expect(page.response.headers.get('cache-control')).toBe('private, no-store');
  expect(page.value!.state).toBe('ready');
  const entry = page.value!.entries.find((row: any) => row.id === id);
  expect(entry).toMatchObject({
    id, reason: 'spam', evidence: 'My retained submission', outcome: null,
    targetSummary: { state: 'available', label: 'Recognizable reported discussion', href: `/v1/threads/${target.threadId}` },
    viewer: { ownsReport: true }, actions: { open: { method: 'GET', href: `/v1/reports/${id}` } },
  });
  expect((await fixture.call('GET', entry.actions.open.href, { bearer: fixture.author.bearer })).response.status).toBe(200);
  expect((await fixture.call('GET', entry.actions.target.href, { bearer: fixture.author.bearer })).response.status).toBe(200);
  expect(entry).not.toHaveProperty('reporterId');
  expect(entry).not.toHaveProperty('transactionId');
  expect(entry.actions).not.toHaveProperty('dismiss');
  expect((await fixture.call('GET', '/v1/reports/me')).response.status).toBe(401);
  const other = await fixture.call('GET', `/v1/reports/me?reportId=${id}`, {
    bearer: fixture.other.bearer,
  });
  expect(other.response.status).toBe(200);
  expect(other.text).not.toContain('My retained submission');
  expect(other.text).not.toContain(id);
  const suspended = await fixture.call('GET', `/v1/reports/me?reportId=${id}`, { bearer: fixture.system.actors.suspended.bearer });
  expect([401, 404]).toContain(suspended.response.status);
  expect(suspended.text).not.toContain(id);
}, 120_000);

test('raw continuation survives an exact old selection, replay and another viewer cannot reuse it', async () => {
  const target = await fixture.createThread(fixture.mainBoardId, 'Page of real reports');
  const ids: string[] = [];
  for (let i = 0; i < 23; i++) ids.push(await fixture.submit({ kind: 'thread', id: target.threadId }));
  const key = randomUUID();
  const replayed = await fixture.submit({ kind: 'thread', id: target.threadId }, { key });
  expect(await fixture.submit({ kind: 'thread', id: target.threadId }, { key })).toBe(replayed);
  const selected = ids[0]!;
  const path = `/v1/reports/me?reportId=${selected}`;
  const first = await fixture.call('GET', path, { bearer: fixture.author.bearer });
  expect(first.response.status).toBe(200);
  expect(first.value!.entries).toHaveLength(21);
  expect(first.value!.entries[0].id).toBe(selected);
  expect(new Set(first.value!.entries.map((entry: any) => entry.id)).size).toBe(21);
  const cursor = encodeURIComponent(first.value!.nextCursor);
  const restore = fixture.failNextCaseFill();
  try {
    const failed = await fixture.call('GET', `${path}&cursor=${cursor}`, { bearer: fixture.author.bearer });
    expect(failed.response.status).toBe(503);
    expect(failed.value).not.toHaveProperty('nextCursor');
  } finally { restore(); }
  const second = await fixture.call('GET', `${path}&cursor=${cursor}`, { bearer: fixture.author.bearer });
  expect(second.response.status).toBe(200);
  expect(second.value!.nextCursor).toBeNull();
  const all = new Set([...first.value!.entries, ...second.value!.entries].map((entry: any) => entry.id));
  for (const id of [...ids, replayed]) expect(all.has(id)).toBe(true);
  expect((await fixture.call('GET', `${path}&cursor=${cursor}`, { bearer: fixture.other.bearer })).response.status).toBe(400);
  expect((await fixture.call('GET', `/v1/reports/me?cursor=${cursor}`, { bearer: fixture.author.bearer })).response.status).toBe(400);
}, 120_000);

test('current target retirement removes its label and action while the native dismissed receipt remains', async () => {
  const target = await fixture.createThread(fixture.mainBoardId, 'Hidden after retirement');
  const id = await fixture.submit({ kind: 'post', id: target.postId });
  const moderator = fixture.system.actors.moderator;
  await fixture.command('POST', '/v1/grants', {
    resource: { route: routeOf(target.postId)!, id: target.postId },
    subject: { kind: 'account', id: moderator.actor.accountId },
    actions: ['moderation:read_reports', 'moderation:takedown'], valid: '(,)',
  }, { bearer: fixture.governance.bearer });
  await fixture.command('POST', `/v1/reports/${id}:dismiss`, {}, { bearer: moderator.bearer, expectedStatus: 200 });
  await fixture.command('POST', `/v1/posts/${target.postId}:takeDown`, { reason: 'Private moderator statement' }, {
    bearer: moderator.bearer, expectedStatus: 200,
  });
  const page = await fixture.call('GET', `/v1/reports/me?reportId=${id}`, { bearer: fixture.author.bearer });
  expect(page.response.status).toBe(200);
  const row = page.value!.entries.find((entry: any) => entry.id === id);
  expect(row).toMatchObject({ outcome: 'dismissed', evidence: 'My retained submission', targetSummary: { state: 'unavailable' } });
  expect(Object.keys(row.targetSummary)).toEqual(['state']);
  expect(row.actions.target).toBeNull();
  expect(page.text).not.toContain('Hidden after retirement');
  expect(page.text).not.toContain('Private moderator statement');
  const opened = await fixture.call('GET', row.actions.follow.href, { bearer: fixture.author.bearer });
  expect(opened.response.status).toBe(200);
  expect(opened.value!.report.outcome).toBe('dismissed');
}, 120_000);
