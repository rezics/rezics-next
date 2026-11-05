import { expect, test } from 'bun:test';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { resolveSubjectTarget } from '../../src/rating/merge-job.ts';

const sourceId = '00000000-0000-7000-8000-3a0700000001';
const terminalId = '00000000-0000-7000-8000-3a0900000002';

function queryClient(row: Record<string, unknown> | null) {
  const calls: unknown[] = [];
  const client = {
    query: async (...args: unknown[]) => {
      calls.push(args[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    },
  };
  return { client: client as Parameters<typeof resolveSubjectTarget>[0], calls };
}

function queryText(query: unknown): string {
  if (typeof query === 'string') return query;
  if (typeof query !== 'object' || query === null || !('text' in query)) return '';
  return String(query.text);
}

test('subject resolution is one hop and checks Semantic currentness in the voter transaction at actual homes', async () => {
  const query = queryClient({ subjectId: terminalId, activeTerminal: true, targetRedirecting: false });
  const homes: number[] = [];
  const result = await resolveSubjectTarget(query.client, sourceId, async (tx, home) => {
    expect(tx).toBe(query.client);
    homes.push(home);
    return { state: 'published', epoch: 1n };
  });
  expect(result).toBe(terminalId);
  expect(query.calls).toHaveLength(1);
  const sql = queryText(query.calls[0]);
  expect(sql).toContain('ORDER BY redirect.sequence DESC');
  expect(sql).toContain('LIMIT 1');
  expect(sql).not.toMatch(/WITH\s+RECURSIVE/i);
  expect(sql).not.toMatch(/FOR\s+SHARE/i);
  expect(sql).not.toMatch(/partition_no\s*=\s*0/i);
  expect(homes).toEqual(
    [partitionOf(routeOf(sourceId)!), partitionOf(routeOf(terminalId)!)].sort((left, right) => left - right),
  );
});

test('a redirecting or inactive target and pending or unavailable Semantic currentness stay pending', async () => {
  for (const state of [
    { activeTerminal: true, targetRedirecting: true },
    { activeTerminal: false, targetRedirecting: false },
  ]) {
    const query = queryClient({ subjectId: terminalId, ...state });
    await expect(
      resolveSubjectTarget(query.client, sourceId, async () => ({ state: 'published', epoch: 1n })),
    ).rejects.toMatchObject({ code: 'identity_epoch_pending', targetId: sourceId });
  }

  const pending = queryClient({ subjectId: terminalId, activeTerminal: true, targetRedirecting: false });
  await expect(
    resolveSubjectTarget(pending.client, sourceId, async () => ({
      state: 'pending',
      publishedEpoch: 0n,
      job: { jobId: sourceId, epoch: 1n },
    })),
  ).rejects.toMatchObject({ code: 'identity_epoch_pending', targetId: sourceId });

  const unavailable = queryClient({ subjectId: terminalId, activeTerminal: true, targetRedirecting: false });
  await expect(
    resolveSubjectTarget(unavailable.client, sourceId, async () => ({ state: 'unavailable', reason: 'bootstrap' })),
  ).rejects.toMatchObject({ code: 'identity_epoch_unavailable', targetId: sourceId });
});

test('a missing direct lookup result is unavailable', async () => {
  const query = queryClient(null);
  await expect(
    resolveSubjectTarget(query.client, sourceId, async () => ({ state: 'published', epoch: 1n })),
  ).rejects.toMatchObject({ code: 'identity_epoch_unavailable', targetId: sourceId });
  expect(query.calls).toHaveLength(1);
});
