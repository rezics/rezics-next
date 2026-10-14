import { expect, spyOn, test } from 'bun:test';
import { Pool, type PoolClient } from 'pg';
import { boundedPool, NestedPoolCheckoutError, nestedPoolCheckoutMode,
  setNestedPoolCheckoutMode } from '../src/infrastructure/pg-pool.ts';
import { AccessAdmissionRegistry, AdmissionDenied, AdmissionUnavailable } from '../src/modules/access/admission.ts';
import { GovernanceStore } from '../src/modules/governance/store.ts';

const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const admission = '00000000-0000-4000-8000-000000000002';
const subject = 'https://rezics.com/id/00000000-0000-4000-8000-000000000003';

async function fixture(run: (pool: Pool, state: {
  checkouts: number; releases: number; statements: string[]; rows: unknown[]; failure?: Error;
}) => Promise<void>) {
  const state = { checkouts: 0, releases: 0, statements: [] as string[],
    rows: [{ acting_subject: subject }] as unknown[], failure: undefined as Error | undefined };
  const connect = spyOn(Pool.prototype, 'connect').mockImplementation(((callback?: unknown) => {
    state.checkouts++;
    const client = {
      query(sql: string) {
        state.statements.push(sql);
        if (sql.includes('FROM access.admission')) {
          if (state.failure) return Promise.reject(state.failure);
          return Promise.resolve({ rows: state.rows, rowCount: state.rows.length });
        }
        const rows = sql.includes('access.recovery_fence') ? [{ open: true }] : [];
        return Promise.resolve({ rows, rowCount: rows.length });
      },
      release() { state.releases++; },
      on() { return client; },
      once() { return client; },
      removeListener() { return client; },
    } as unknown as PoolClient;
    if (typeof callback === 'function') {
      (callback as (error: undefined, client: PoolClient, release: () => void) => void)(undefined, client, client.release);
      return;
    }
    return Promise.resolve(client);
  }) as Pool['connect']);
  const mode = nestedPoolCheckoutMode();
  setNestedPoolCheckoutMode('throw');
  const pool = boundedPool({ max: 1, connectionTimeoutMillis: 50 });
  try { await run(pool, state); }
  finally {
    setNestedPoolCheckoutMode(mode);
    connect.mockRestore();
    await pool.end();
  }
}

test('publication contributor admission reads share the fence checkout and transaction', async () => {
  await fixture(async (pool, state) => {
    const access = new AccessAdmissionRegistry(pool);
    const governance = new GovernanceStore(pool, {} as never, {} as never, {} as never);
    expect(await governance.withPublicationFence([work], async allowed => {
      expect(allowed).toBe(true);
      // Publication checks contributor admissions concurrently in bounded batches.
      const subjects = await Promise.all([access.admittedActingSubject(admission),
        access.admittedActingSubject(admission)]);
      expect(state.statements.filter(sql => sql === 'COMMIT')).toHaveLength(0);
      expect(state.releases).toBe(0);
      return subjects;
    })).toEqual([subject, subject]);
    expect(state.checkouts).toBe(1);
    expect(state.releases).toBe(1);
    expect(state.statements.filter(sql => sql === 'BEGIN')).toHaveLength(1);
    expect(state.statements.filter(sql => sql === 'COMMIT')).toHaveLength(1);
    expect(state.statements.filter(sql => sql === 'ROLLBACK')).toHaveLength(0);

    expect(await access.admittedActingSubject(admission)).toBe(subject);
    expect(state.checkouts).toBe(2);
    expect(state.releases).toBe(2);
    expect(state.statements.filter(sql => sql === 'COMMIT')).toHaveLength(2);
  });
});

test('absent contributor provenance is denied without ending the publication fence', async () => {
  await fixture(async (pool, state) => {
    state.rows = [];
    const access = new AccessAdmissionRegistry(pool);
    const governance = new GovernanceStore(pool, {} as never, {} as never, {} as never);
    await governance.withPublicationFence([work], async () => {
      await expect(access.admittedActingSubject(admission)).rejects.toBeInstanceOf(AdmissionDenied);
      expect(state.statements.filter(sql => sql === 'ROLLBACK' || sql === 'COMMIT')).toHaveLength(0);
      expect(state.releases).toBe(0);
    });
    expect(state.checkouts).toBe(1);
    expect(state.releases).toBe(1);
    expect(state.statements.filter(sql => sql === 'COMMIT')).toHaveLength(1);
  });
});

test('an unavailable contributor read rolls back only through the publication fence owner', async () => {
  await fixture(async (pool, state) => {
    state.failure = Object.assign(new Error('statement timed out'), { code: '57014' });
    const access = new AccessAdmissionRegistry(pool);
    const governance = new GovernanceStore(pool, {} as never, {} as never, {} as never);
    await expect(governance.withPublicationFence([work], () => access.admittedActingSubject(admission)))
      .rejects.toBeInstanceOf(AdmissionUnavailable);
    expect(state.checkouts).toBe(1);
    expect(state.releases).toBe(1);
    expect(state.statements.filter(sql => sql.includes('FROM access.admission'))).toHaveLength(1);
    expect(state.statements.filter(sql => sql === 'ROLLBACK')).toHaveLength(1);
    expect(state.statements.filter(sql => sql === 'COMMIT')).toHaveLength(0);
  });
});

test('ordinary admission reads still detect an unshared nested checkout', async () => {
  await fixture(async (pool, state) => {
    const client = await pool.connect();
    try {
      await expect(pool.connect()).rejects.toBeInstanceOf(NestedPoolCheckoutError);
      await expect(new AccessAdmissionRegistry(pool).admittedActingSubject(admission))
        .rejects.toBeInstanceOf(AdmissionUnavailable);
      expect(state.checkouts).toBe(1);
      expect(state.releases).toBe(0);
    } finally { client.release(); }
  });
});
