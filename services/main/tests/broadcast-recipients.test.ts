import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import {
  relationshipRecipientPage,
  RELATIONSHIP_RECIPIENT_COST,
} from '../src/modules/follows/recipients.ts';
import { NotificationProducer } from '../src/modules/notification-producers/producer.ts';
import type { NotificationEvent } from '../src/modules/notification/store.ts';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';

const principal = (n: number) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;

test('an empty eligible batch advances the examined frontier, rather than ending a broadcast', async () => {
  const statements: { sql: string; args: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, args: unknown[]) => {
      statements.push({ sql, args });
      const after = args[5] as string | null;
      return {
        rows: Array.from({ length: after ? 12 : 257 }, (_, i) => ({
          id: principal((after ? 256 : 0) + i + 1),
          eligible: after !== null,
        })),
      };
    },
  } as unknown as Pool;
  const first = await relationshipRecipientPage(pool, { targets: ['work'], highlights: true });
  expect(first).toEqual({ items: [], nextCursor: principal(256) });
  const next = await relationshipRecipientPage(
    pool,
    { targets: ['work'], highlights: true },
    first.nextCursor,
  );
  expect(next.items).toEqual(Array.from({ length: 12 }, (_, i) => principal(257 + i)));
  expect(next.nextCursor).toBeNull();
  expect(statements[1]!.args[5]).toBe(principal(256));
  expect(RELATIONSHIP_RECIPIENT_COST.examinedPerBatch).toBe(256);
});

test('the frontier counts ineligible and absent direct principals, not only selected recipients', async () => {
  const pool = {
    query: async () => ({
      rows: Array.from({ length: 257 }, (_, i) => ({
        id: principal(i + 1),
        eligible: i % 2 === 0,
      })),
    }),
  } as unknown as Pool;
  const page = await relationshipRecipientPage(pool, { targets: [], highlights: false });
  expect(page.items).toHaveLength(128);
  expect(page.nextCursor).toBe(principal(256));
  await expect(
    relationshipRecipientPage(pool, { targets: Array(8).fill('work'), highlights: false }),
  ).rejects.toThrow('input bound exceeded');
});

for (const complete of [false, true]) {
  test(`editorial intake uses its held client and advances the source only when complete=${complete}`, async () => {
    const statements: string[] = [];
    let released = false;
    const resource = 'https://rezics.com/id/00000000-0000-0000-0000-000000000099';
    const client = {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes('SELECT open')) return { rows: [{ open: true }] };
        if (sql.includes('SELECT position::text'))
          return {
            rows: [{ position: statements.some((s) => s.includes('SET position =')) ? '1' : '0' }],
          };
        if (sql.includes('FROM access.editorial_event e'))
          return {
            rows: [
              {
                sequence: '1',
                id: principal(1),
                proposal: principal(2),
                revision: 1,
                kind: 'created',
                actor: resource,
                occurredAt: '2026-01-01',
              },
            ],
          };
        if (sql.includes('SELECT p.proposer_principal'))
          return {
            rows: [
              {
                proposer_principal: principal(3),
                reverts: null,
                review: null,
                actor_principal: principal(3),
                resource,
                work: resource,
                context: 'global',
              },
            ],
          };
        return { rows: [] };
      },
      release: () => {
        released = true;
      },
    } as unknown as PoolClient;
    const access = {
      connect: async () => client,
      query: async (sql: string) => {
        if (!sql.includes('sequence_editorial_events')) throw new Error('nested pool query');
        return { rows: [] };
      },
    } as unknown as Pool;
    let received: NotificationEvent | undefined;
    const producer = new NotificationProducer(
      access,
      null,
      {} as Pool,
      {} as FusekiClient,
      {
        enqueue: async (notice, held) => {
          received = notice;
          expect(held).toBe(client);
          return Object.assign([], { complete });
        },
      },
      null,
    );
    expect(await producer.runEditorialOnce()).toBe(1);
    expect(received?.recipients).toEqual([]);
    expect(received?.relationshipPlan).toBeDefined();
    expect(statements.some((sql) => sql.includes('SET position ='))).toBe(complete);
    expect(statements.filter((sql) => sql === 'COMMIT')).toHaveLength(complete ? 2 : 1);
    expect(released).toBe(true);
  });
}

test('safety correspondence releases the Access pool before independent intake and fences its monotonic acknowledgement', async () => {
  let held = false;
  const statements: string[] = [];
  const row = { epoch: '1', xid: '2', id: '3', kind: 'moderation_outcome', event_id: principal(4) };
  const client = {
    query: async (sql: string) => {
      statements.push(sql);
      return { rows: sql.includes('SELECT open') ? [{ open: true }] : [] };
    },
    release: () => {
      held = false;
    },
  } as unknown as PoolClient;
  const access = {
    connect: async () => {
      expect(held).toBe(false);
      held = true;
      return client;
    },
    query: async (sql: string) => {
      expect(held).toBe(false);
      if (sql.includes('SELECT open')) return { rows: [{ open: true }] };
      if (sql.includes('FROM access.notification_producer_event')) return { rows: [row] };
      return { rows: [] };
    },
  } as unknown as Pool;
  const producer = new NotificationProducer(
    access,
    null,
    {} as Pool,
    {} as FusekiClient,
    { enqueue: async () => [] },
    null,
  );
  let intakes = 0;
  producer.setSafetyCorrespondence({
    enqueueDecision: async (event) => {
      expect(event).toBe(row.event_id);
      expect(held).toBe(false);
      await access.query('SELECT 1');
      intakes++;
    },
  });
  expect(await producer.runSafetyCorrespondenceOnce()).toBe(1);
  expect(intakes).toBe(1);
  expect(
    statements.some((sql) => sql.includes('< (EXCLUDED.epoch,EXCLUDED.xid,EXCLUDED.id)')),
  ).toBe(true);
  expect(statements).toContain('COMMIT');
  expect(held).toBe(false);
});
