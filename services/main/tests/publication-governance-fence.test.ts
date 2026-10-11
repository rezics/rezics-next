import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { GovernanceStore } from '../src/modules/governance/store.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { withStructuredPublicationFence } from '../src/routes/publication.ts';

const workId = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const parent = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const targetLock = (resource: string) => JSON.stringify(['graph', resource, 'structure']);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function database() {
  let restricted = false;
  let nextId = 0;
  const owners = new Map<string, Client>();
  const waiters = new Map<string, Array<{ client: Client; resolve: () => void }>>();
  const lockWaited = deferred();
  interface Client {
    id: number;
    locks: Set<string>;
    query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }>;
    release(): void;
  }
  const releaseLocks = (client: Client) => {
    for (const key of client.locks) {
      if (owners.get(key) !== client) continue;
      owners.delete(key);
      const waiting = waiters.get(key)?.shift();
      if (waiting) {
        owners.set(key, waiting.client);
        waiting.client.locks.add(key);
        waiting.resolve();
      }
    }
    client.locks.clear();
  };
  const acquire = async (client: Client, key: string) => {
    const owner = owners.get(key);
    if (!owner || owner === client) {
      owners.set(key, client);
      client.locks.add(key);
      return;
    }
    lockWaited.resolve();
    await new Promise<void>(resolve => {
      const queue = waiters.get(key) ?? [];
      queue.push({ client, resolve });
      waiters.set(key, queue);
    });
  };
  const pool = {
    connect: async () => {
      const client: Client = {
        id: ++nextId,
        locks: new Set(),
        async query(sql, values = []) {
          if (sql === 'BEGIN' || sql.startsWith('SET LOCAL')) return { rows: [], rowCount: 0 };
          if (sql === 'COMMIT' || sql === 'ROLLBACK') {
            releaseLocks(client);
            return { rows: [], rowCount: 0 };
          }
          if (sql.includes('access.recovery_fence')) return { rows: [{ open: true }], rowCount: 1 };
          if (sql.includes('pg_advisory_xact_lock')) {
            await acquire(client, String(values[0]));
            return { rows: [], rowCount: 0 };
          }
          if (sql.includes('FROM access.governance_enforcement')) {
            const rows = restricted ? [{}] : [];
            return { rows, rowCount: rows.length };
          }
          throw new Error(`Unexpected governance query: ${sql}`);
        },
        release() { releaseLocks(client); },
      };
      return client;
    },
  } as unknown as Pool;
  return {
    pool,
    lockWaited: lockWaited.promise,
    restricted: () => restricted,
    async writeRestriction(resource: string) {
      const client = await pool.connect();
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 512))', [targetLock(resource)]);
      restricted = true;
      await client.query('COMMIT');
      client.release();
    },
  };
}

function governance(pool: Pool) {
  return new GovernanceStore(pool, {} as never, {} as never, {} as never);
}

test('a restriction committed after an earlier preflight refuses the native publication CAS', async () => {
  const db = database();
  const store = governance(db.pool);
  const preflightAllowed = !db.restricted();
  expect(preflightAllowed).toBe(true);
  await db.writeRestriction(workId);

  const work = { environment: { fuseki: { query: async () => ({ results: { bindings: [
    { parent: { value: parent } },
  ] } }) } }, governance: { store } } as unknown as MainWorkDependencies;
  let casCalled = false;
  const result = await withStructuredPublicationFence(work, workId, async allowed => {
    if (allowed) casCalled = true;
    return allowed;
  });
  expect(result).toBe(false);
  expect(casCalled).toBe(false);
});

test('restriction writers wait for the publication CAS after the atomic fence read', async () => {
  const db = database();
  const store = governance(db.pool);
  const enteredCas = deferred();
  const finishCas = deferred();
  let casCompleted = false;
  const publication = store.withPublicationFence([workId], async allowed => {
    expect(allowed).toBe(true);
    enteredCas.resolve();
    await finishCas.promise;
    casCompleted = true;
    return 'committed';
  });
  await enteredCas.promise;

  let restrictionCommitted = false;
  const restriction = db.writeRestriction(workId).then(() => { restrictionCommitted = true; });
  await db.lockWaited;
  expect(restrictionCommitted).toBe(false);
  expect(db.restricted()).toBe(false);

  finishCas.resolve();
  expect(await publication).toBe('committed');
  await restriction;
  expect(casCompleted).toBe(true);
  expect(restrictionCommitted).toBe(true);
  expect(db.restricted()).toBe(true);
});
