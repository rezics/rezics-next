import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { loadVndbStatisticsDriver, type Exchange, type VndbStatisticsDriver } from './imports-vndb-statistics-driver';

const scopes = [
  'subject:create',
  'subject:batch_write',
  'statement:propose',
  'source_fence:read',
  'media:import_from_url',
  'media:read_reservation',
  'source_statistic:write',
];
const global = { route: 0, id: '00000000-0000-8000-8000-000000000000' };
const expected = {
  source: 'vndb',
  sourceRecordId: 'v123',
  mean: 7.35,
  count: 20,
  scale: { min: 1, max: 10 },
  asOf: '2026-10-25',
  licence: 'ODbL-1.0',
  attribution: 'VNDB',
};

// Synthetic COPY rows use the pinned real column headers. No pregrouped records.
// Keep entry_meta.revision unchanged even when the native average changes.
async function* archive(average = 735, count = 20, empty = false): AsyncIterable<Uint8Array> {
  for (const name of ['vn.header', 'vn', 'vn_titles.header', 'vn_titles', 'entry_meta.header', 'entry_meta']) {
    let text = readFileSync(new URL(`./fixtures/imports/vndb-tables/db/${name}`, import.meta.url), 'utf8');
    if (!name.endsWith('.header')) {
      text =
        text
          .split('\n')
          .filter((line) => line && (!empty || line.startsWith('v124\t')))
          .join('\n') + '\n';
      if (name === 'vn' && !empty) {
        const rows = text.trimEnd().split('\n');
        const cells = rows[0]!.split('\t');
        cells[4] = String(count);
        cells[6] = String(average);
        rows[0] = cells.join('\t');
        text = rows.join('\n') + '\n';
      }
    }
    const body = new TextEncoder().encode(text);
    const header = new Uint8Array(512);
    const put = (offset: number, value: string) => header.set(new TextEncoder().encode(value), offset);
    put(0, `db/${name}`);
    put(100, '0000644\0');
    put(108, '0000000\0');
    put(116, '0000000\0');
    put(124, body.length.toString(8).padStart(11, '0') + '\0');
    put(136, '00000000000\0');
    put(148, '        ');
    put(156, '0');
    put(257, 'ustar\0');
    put(263, '00');
    put(
      148,
      header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, '0') + '\0 ',
    );
    yield header;
    yield body;
    if (body.length % 512) yield new Uint8Array(512 - (body.length % 512));
  }
  yield new Uint8Array(1024);
}
async function scenario(run: (d: VndbStatisticsDriver) => Promise<void>) {
  const d = await loadVndbStatisticsDriver();
  try {
    await run(d);
  } finally {
    await d.close();
  }
}
const puts = (requests: Exchange[]) =>
  requests.filter((r) => r.method === 'PUT' && r.path.endsWith('/source-statistics/vndb'));
async function permits(d: VndbStatisticsDriver, bearer: string) {
  const { accessCheck } = await import('../services/kernel/src/request/access.ts');
  const { withConnection } = await import('../services/kernel/src/database/pool.ts');
  const context = { pool: d.identity.database.pool, deadline: Date.now() + 10_000 };
  const actor = await d.identity.access.authenticate(bearer, context);
  const check = await accessCheck(d.identity.access, actor, 'source_statistic:write', global, context);
  return withConnection(context.pool, (client) => check(client));
}
function denied(reply: Exchange) {
  expect(reply.status).toBe(403);
  expect(reply.receipt).toBeNull();
  expect(reply.response).toEqual({
    type: 'https://rezics.com/problems/forbidden',
    title: 'Forbidden',
    status: 403,
    code: 'forbidden',
    retryable: false,
    effect_status: 'not_applied',
    request_id: expect.any(String),
  });
  // Error bodies must not disclose stored statistics or an old successful receipt.
  expect(JSON.stringify(reply.response)).not.toContain('sourceRecordId');
  expect(JSON.stringify(reply.response)).not.toContain('ODbL');
}

test('pinned COPY reaches seven-scope Auth, real Access, public bulk identity and statistic PUT/current GET', () =>
  scenario(async (d) => {
    expect([...d.identity.client.scopes].sort()).toEqual([...scopes].sort());
    const actor = await d.identity.access.authenticate(d.identity.bulk.bearer, {
      pool: d.identity.database.pool,
      deadline: Date.now() + 10_000,
    });
    expect(actor.accountId).toBe(d.identity.bulk.accountId);
    expect([...actor.scopes].sort()).toEqual([...scopes].sort());
    expect(await permits(d, d.identity.bulk.bearer)).toBe(true);
    const run = await d.run(archive());
    expect(run.outcome).toBe('committed');
    expect(run.sourceRecords.find((r) => r.key === 'v123')).toEqual({
      key: 'v123',
      revision: 7,
      average: 735,
      count: 20,
    });
    expect(
      run.exchanges.some((r) => r.method === 'POST' && r.path === '/v1/subjects:batchWrite' && r.status === 200),
    ).toBe(true);
    const view = await d.observe();
    expect(view.subjectId).toBeTruthy();
    expect(view.currentRequest).toEqual({
      method: 'GET',
      path: `/v1/subjects/${view.subjectId}/source-statistics`,
      authorization: null,
    });
    const bulkReplies = run.exchanges.filter((r) => r.method === 'POST' && r.path === '/v1/subjects:batchWrite');
    expect(
      bulkReplies.some((r) =>
        (r.response as { results: { status: number; value?: { id?: string } }[] }).results.some(
          (result) => result.status < 300 && result.value?.id === view.subjectId,
        ),
      ),
    ).toBe(true);
    const writes = puts(run.exchanges);
    expect(writes).toHaveLength(1);
    const write = writes[0]!;
    expect(write.path).toBe(`/v1/subjects/${view.subjectId}/source-statistics/vndb`);
    expect(write.authorization).toBe(`Bearer ${d.identity.bulk.bearer}`);
    expect(write.idempotencyKey).toBeTruthy();
    expect(write.receipt).toBeTruthy();
    expect(write.status).toBe(200);
    expect(write.response).toEqual(expected);
    const { source: _, ...body } = expected;
    expect(JSON.parse(write.body!)).toEqual(body);
    expect(view.current).toEqual({ status: 200, body: [expected] });
    expect(view.storage.statistics).toEqual([expected]);
    expect(view.storage.statisticTransactions).toHaveLength(1);
    expect(view.storage.statisticEvents).toHaveLength(1);
    expect(view.storage.statisticReceipts).toEqual([write.receipt!]);
    expect(view.storage.nativeVoteRows).toBe(0);
  }));

test('reimport and reopen are no-ops; changed native average updates once without native votes', () =>
  scenario(async (d) => {
    await d.run(archive());
    const before = await d.observe();
    for (const reopen of [false, true]) {
      if (reopen) await d.reopen();
      expect((await d.run(archive())).outcome).toBe('committed');
      expect(await d.observe()).toEqual(before);
    }
    const changed = await d.run(archive(810));
    expect(changed.outcome).toBe('committed');
    expect(changed.sourceRecords.find((r) => r.key === 'v123')).toEqual({
      key: 'v123',
      revision: 7,
      average: 810,
      count: 20,
    });
    const after = await d.observe();
    expect(after.subjectId).toBe(before.subjectId);
    expect(after.current).toEqual({ status: 200, body: [{ ...expected, mean: 8.1 }] });
    expect(after.storage.statistics).toEqual([{ ...expected, mean: 8.1 }]);
    expect(after.storage.statisticTransactions).toHaveLength(1);
    expect(after.storage.statisticTransactions).not.toEqual(before.storage.statisticTransactions);
    expect(after.storage.statisticEvents).toHaveLength(2);
    expect(after.storage.statisticReceipts).toHaveLength(2);
    expect(after.storage.nativeVoteRows).toBe(0);
  }));

test('lost committed response retries original bytes and idempotency identity with one effect', () =>
  scenario(async (d) => {
    const run = await d.run(archive(), { loseStatisticResponse: true });
    expect(run.outcome).toBe('committed');
    const requests = puts(run.exchanges);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests[0]!.responseLost).toBe(true);
    for (const retry of requests.slice(1)) {
      for (const field of ['body', 'idempotencyKey', 'authorization', 'path', 'receipt'] as const)
        expect(retry[field]).toEqual(requests[0]![field]);
      expect(retry.status).toBe(200);
      expect(retry.response).toEqual(expected);
    }
    const view = await d.observe();
    expect(view.current).toEqual({ status: 200, body: [expected] });
    expect(view.storage.statisticEvents).toHaveLength(1);
    expect(view.storage.statisticReceipts).toHaveLength(1);
    expect(view.storage.nativeVoteRows).toBe(0);
  }));

test('zero votes invent neither statistic nor native votes', () =>
  scenario(async (d) => {
    const run = await d.run(archive(735, 0));
    expect(run.outcome).toBe('committed');
    expect(puts(run.exchanges)).toEqual([]);
    const view = await d.observe();
    expect(view.subjectId).toBeTruthy();
    expect(view.current).toEqual({ status: 200, body: [] });
    expect(view.storage).toEqual({
      statistics: [],
      statisticTransactions: [],
      statisticEvents: [],
      statisticReceipts: [],
      nativeVoteRows: 0,
    });
  }));

test('reduced real Auth scope denies before persistence; revoked grant denies original-bearer receipt replay', () =>
  scenario(async (d) => {
    const limited = await d.issue(scopes.filter((scope) => scope !== 'source_statistic:write'));
    expect(limited.accountId).toBe(d.identity.bulk.accountId);
    expect(await permits(d, limited.bearer)).toBe(false);
    const before = (await d.observe()).storage;
    const rejected = await d.run(archive(), { credential: limited });
    expect(rejected.outcome).toBe('denied');
    expect(puts(rejected.exchanges)).toHaveLength(1);
    denied(puts(rejected.exchanges)[0]!);
    expect((await d.observe()).storage).toEqual(before);
    await d.reopen();
    const success = await d.run(archive());
    expect(success.outcome).toBe('committed');
    const original = puts(success.exchanges)[0]!;
    expect(original.authorization).toBe(`Bearer ${d.identity.bulk.bearer}`);
    const baseline = await d.observe();
    const bearer = d.identity.bulk.bearer;
    await d.setStatisticGrant(false);
    expect(d.identity.bulk.bearer).toBe(bearer);
    expect(await permits(d, bearer)).toBe(false);
    denied(await d.replay(original));
    expect(await d.observe()).toEqual(baseline);
    const changed = await d.run(archive(810));
    expect(changed.outcome).toBe('denied');
    expect(puts(changed.exchanges)).toHaveLength(1);
    denied(puts(changed.exchanges)[0]!);
    expect(await d.observe()).toEqual(baseline);
  }));

test('source acquisition and mass disappearance failure send no statistic and preserve baseline', () =>
  scenario(async (d) => {
    await d.run(archive());
    const baseline = await d.observe();
    async function* broken() {
      for await (const bytes of archive(810)) {
        yield bytes;
        throw new Error('source acquisition failed');
      }
    }
    for (const [input, outcome] of [
      [broken(), 'invalid-dump'],
      [archive(735, 20, true), 'mass-disappearance'],
    ] as const) {
      const run = await d.run(input, { disappearanceThreshold: 0 });
      expect(run.outcome).toBe(outcome);
      expect(puts(run.exchanges)).toEqual([]);
      expect(await d.observe()).toEqual(baseline);
    }
  }));
