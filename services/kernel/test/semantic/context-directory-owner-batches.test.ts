import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { authoritativeTimeValue, mintReadTime, type AuthoritativeTime } from '../../src/command/command.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { type ContextAccessPort, type ContextQueryClient } from '../../src/semantic/context-access-port.ts';
import { createContextDirectory } from '../../src/semantic/context-directory.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

test('Context directory resumes across bounded owner batches and conceals a changed current-owner proof', async () => {
  const contexts = Array.from({ length: 51 }, () => ({ id: newId(16) })).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const accountIds = Array.from({ length: contexts.length * 2 }, () => newId(32));
  const replacementOwner = newId(32);
  const ownerRows = new Map(contexts.map((context, index) => [context.id, accountIds.slice(index * 2, index * 2 + 2)]));
  const changed = contexts[4]!;
  const changedOwners = ownerRows.get(changed.id)!;
  const activeAccounts = new Set([...accountIds, replacementOwner]);
  const grantReads: { ids: number; rows: number }[] = [];
  const accountReads: number[] = [];
  const rawAfter: string[] = [];
  let ownerChanged = false;

  const client = {
    async query(input: unknown, positional?: readonly unknown[]) {
      const query =
        typeof input === 'string'
          ? { text: input, values: positional ?? [] }
          : (input as { text?: string; values?: unknown[] });
      const sql = query.text ?? '';
      const values = query.values ?? positional ?? [];
      let rows: Record<string, unknown>[] = [];
      if (sql.includes('COALESCE(NULLIF')) {
        rows = [{ at: values[0] }];
      } else if (sql.includes('FROM core.partition')) {
        const partitionNo = Number(values[0]);
        rows = [{ partitionNo, node: 'local', writeState: 'active', movedTo: null, epoch: 1, position: '0' }];
      } else if (sql.includes('UNION ALL') && sql.includes('context_directory_home')) {
        rows = [];
      } else if (sql.includes('search_key') && sql.includes('FROM semantic.context_directory_entry')) {
        const after = String(values[1]);
        rawAfter.push(after);
        rows = contexts
          .filter((context) => context.id > after)
          .slice(0, 100)
          .map((context) => ({ id: context.id, key: '', language: '', version: '1', source_epoch: 1 }));
      } else if (sql.includes('FROM access.resource_role_grant')) {
        const ids = values[1] as string[];
        const grants = ids
          .flatMap((id) => (ownerRows.get(id) ?? []).map((account) => ({ id, account })))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.account < b.account ? -1 : 1));
        rows = grants.slice(0, 101);
        grantReads.push({ ids: ids.length, rows: rows.length });
      } else if (sql.includes('FROM access.account')) {
        const ids = values[1] as string[];
        accountReads.push(ids.length);
        rows = ids.filter((id) => activeAccounts.has(id)).map((id) => ({ id }));
        if (!ownerChanged) {
          ownerRows.set(changed.id, [changedOwners[0]!, replacementOwner]);
          ownerChanged = true;
        }
      } else if (sql.includes('FROM semantic.context c')) {
        const ids = values[1] as string[];
        rows = ids.map((id) => ({ id, kind: 'community', state: 'active', restorable: false, owner: false }));
      } else if (sql.includes('security_revision::text AS version')) {
        const ids = values[1] as string[];
        rows = ids.map((id) => ({ id, version: '1' }));
      } else if (sql.includes('FROM semantic.context')) {
        const ids = values[1] as string[];
        rows = ids.map((id) => ({
          id,
          kind: 'community',
          labels: { en: `Context ${id}` },
          state: 'active',
          deletedAt: null,
          purgeAfter: null,
          version: '1',
        }));
      }
      return { rows, rowCount: rows.length };
    },
  } as unknown as ContextQueryClient;

  let time: AuthoritativeTime | undefined;
  const port = {
    deadlineClient: (queryClient: ContextQueryClient) => queryClient,
    requireDeadline: () => {},
    withReadTransaction: async (_pool: Pool, read: (connection: ContextQueryClient) => Promise<unknown>) =>
      read(client),
    prepareReadDecisions: async () => ({
      decide: async (_connection: ContextQueryClient, input: { ids: readonly string[] }) => {
        expect(time).toBeDefined();
        expect(authoritativeTimeValue(time!)).toBe(fixedTime.toISOString());
        return Object.fromEntries(input.ids.map((id) => [id, { allowed: true }]));
      },
    }),
    viewerActionReadTime: () => time!,
    requestInvalid: () => new Error('invalid request'),
  } as unknown as ContextAccessPort;
  const fixedTime = new Date('2026-11-14T00:00:00.000Z');
  const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) };
  const directory = createContextDirectory({
    pool: {} as Pool,
    access: {},
    tokens,
    ports: port,
    clock: () => fixedTime,
  });
  const list = async (cursor?: string | null) => {
    time = await mintReadTime(client, () => fixedTime);
    return directory.list({
      actor: { kind: 'anonymous' },
      deadline: Date.now() + 10_000,
      limit: 20,
      ...(cursor ? { cursor } : {}),
    });
  };

  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await list(cursor);
    seen.push(...page.contexts.map((context) => context.id));
    cursor = page.next;
  } while (cursor);

  expect(ownerChanged).toBe(true);
  expect(seen).toHaveLength(50);
  expect(seen).toEqual(contexts.filter((context) => context.id !== changed.id).map((context) => context.id));
  expect(new Set(seen).size).toBe(50);
  // The first page consumes the concealed fifth raw key to fill 20 results, then resumes after key 21.
  expect(rawAfter[1]).toBe(contexts[20]!.id);
  expect(grantReads.some((read) => read.ids === 51 && read.rows === 101)).toBe(true);
  expect(grantReads.some((read) => read.ids === 25)).toBe(true);
  expect(grantReads.some((read) => read.ids === 26)).toBe(true);
  expect(grantReads.every((read) => read.rows <= 101)).toBe(true);
  expect(accountReads).toEqual([100, 2, 60, 20]);
  expect(accountReads.every((size) => size <= 100)).toBe(true);
  expect(grantReads).toHaveLength(13);
  expect(partitionOf(routeOf(changed.id)!)).toBe(1);
});
