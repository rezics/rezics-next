import { expect, test } from 'bun:test';
import type { AuthErasureSource } from '@rezics/auth-contract';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import {
  createAuthHistoryProofBindings,
  readAuthHistoryCompletion,
  readAuthNativeConsumption,
} from '../../src/access/shared-history-auth.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase } from '../support/growth.ts';
import { cookies, nativeFixture, password, scopes } from './native-account-bindings-fixture.ts';

async function eventually(probe: () => Promise<boolean>) {
  const end = Date.now() + 30000;
  while (!(await probe())) {
    if (Date.now() > end) throw new Error('Native source acceptance timed out');
    await Bun.sleep(50);
  }
}

test('the default Auth-only boundary stores only its exact discharged native source; phase reads and immutable proof writes stay account-bounded', async () => {
  const db = await openGrowthDatabase();
  const f = await nativeFixture(db.pool);
  const ports = f.bindings.trustedAccess;
  let release = () => {};
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  let source: AuthErasureSource | null = null;
  let reads = 0;
  const read = ports.readAuthErasureSource!;
  ports.readAuthErasureSource = async (input) => {
    const value = await read(input);
    source = value;
    if (++reads === 2) await paused;
    return value;
  };
  try {
    const human = await f.person('history_native_source');
    await f.host.service.internal.registerClient({
      clientId: 'proof-deletion',
      firstParty: true,
      scopes: [...scopes, 'account:delete'],
    });
    const signin = await f.request('/signin', {
      email: 'history_native_source@ordinary.test',
      password,
      client_id: 'proof-deletion',
      scope: [...scopes, 'account:delete'],
    });
    expect(signin.status).toBe(200);
    const headers = cookies(signin);
    const operation = { kind: 'delete', accountId: human.accountId };
    const approval = await f.request(
      '/account-operations/approve',
      { operationKey: 'history-source-delete', operation },
      headers,
    );
    expect(approval.status).toBe(200);
    const { reference } = (await approval.json()) as { reference: string };
    const deletion = f.request(
      '/account-operations/execute',
      { operationKey: 'history-source-delete', operation, reference },
      headers,
    );
    await eventually(async () => reads === 2);
    expect(source).not.toBeNull();
    const exact = source!;
    expect(await readAuthNativeConsumption(db.pool, exact)).toBe(false);
    expect(
      (
        await f.authPool.query(
          'SELECT source_accepted_at,source_discharged_at,user_deleted_at FROM auth_erasure WHERE account_id=$1',
          [human.accountId],
        )
      ).rows[0],
    ).toMatchObject({ source_discharged_at: null, user_deleted_at: null });
    release();
    expect((await deletion).status).toBe(200);
    expect(await readAuthNativeConsumption(db.pool, exact)).toBe(true);
    const barrier = { accountId: exact.accountId, version: exact.version, at: exact.at };
    expect(await readAuthHistoryCompletion(db.pool, barrier)).toBe(false);
    // The actual source row is required; no arbitrary local helper/progress row
    // or generic Auth binding supplies this capability.
    const fixed = createAuthHistoryProofBindings(db.pool);
    await expect(
      fixed.recordAuthNativeConsumption({ ...exact, receiptId: newId(routeOf(exact.accountId)!) }),
    ).rejects.toThrow('denied');
    await expect(
      fixed.recordAuthNativeConsumption({ ...exact, continuationId: newId(routeOf(exact.accountId)!) }),
    ).rejects.toThrow('denied');
    await expect(fixed.recordAuthNativeConsumption({ ...exact, version: exact.version + 1 })).rejects.toThrow('denied');
    await expect(fixed.recordAuthNativeConsumption({ ...exact, at: new Date().toISOString() })).rejects.toThrow(
      'denied',
    );
    await expect(fixed.recordAuthNativeConsumption({ ...exact, operation: 'other' } as never)).rejects.toThrow(
      'denied',
    );
    await expect(
      fixed.recordAuthHistoryCompletion({ ...barrier, accountId: newId(routeOf(exact.accountId)!) }),
    ).rejects.toThrow('denied');
    const generic = createAuthBindings({ pool: db.pool });
    await expect(generic.recordAuthNativeConsumption!(exact)).rejects.toThrow('unavailable');
    await expect(
      db.admin.query('UPDATE access.auth_history_proof SET version=version+1 WHERE route=$1 AND account_id=$2', [
        routeOf(exact.accountId),
        exact.accountId,
      ]),
    ).rejects.toThrow('immutable');
    expect(
      (await db.admin.query('SELECT 1 FROM access.erasure_acknowledgement WHERE account_id=$1', [exact.accountId]))
        .rowCount,
    ).toBe(0);
    const route = routeOf(exact.accountId)!;
    const report = await checkGrowth(db, {
      name: 'fixed Auth native-consumption proof submission and Access consumption',
      scales: [256, 1024, 4096],
      repetitions: 1,
      warmups: 1,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      async grow(current, scale, previous) {
        const ids = Array.from({ length: scale - previous }, () => newId(route));
        await current.admin.query(
          "INSERT INTO access.account(route,account_id,kind,state,transaction_id,authn_fenced) SELECT $1,id,'actor','deleted',id,true FROM unnest($2::uuid[]) id",
          [route, ids],
        );
        await current.admin.query(
          'INSERT INTO access.erasure(route,account_id,version,at) SELECT $1,id,1,now() FROM unnest($2::uuid[]) id',
          [route, ids],
        );
        await current.admin.query(
          "INSERT INTO access.auth_history_proof(route,account_id,phase,version,at) SELECT route,account_id,'copies-erased',version,at FROM access.erasure WHERE route=$1 AND account_id=ANY($2::uuid[])",
          [route, ids],
        );
      },
      async operation() {
        // Lost-reply/restart redrive is the identical immutable fact, even if
        // the source continuation has since been scrubbed by its own owner.
        await fixed.recordAuthNativeConsumption(exact);
        expect(await readAuthNativeConsumption(db.pool, exact)).toBe(true);
        expect(await readAuthHistoryCompletion(db.pool, barrier)).toBe(false);
      },
    });
    expect(report.samples.map((s) => s.scale)).toEqual([256, 1024, 4096]);
    expect(
      (
        await db.admin.query('SELECT phase FROM access.auth_history_proof WHERE route=$1 AND account_id=$2', [
          route,
          exact.accountId,
        ])
      ).rows,
    ).toEqual([{ phase: 'native-consumed' }]);
  } finally {
    release();
    await f.close();
    await db.close();
  }
}, 180000);

test('the fixed kernel completion verifier refuses the phase before genuine native discharge, then independently exposes only the exact consumed dependency', async () => {
  const db = await openGrowthDatabase();
  const f = await nativeFixture(db.pool);
  const ports = f.bindings.trustedAccess;
  const read = ports.readAuthErasureSource!;
  let release = () => {};
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  let original: AuthErasureSource | null = null;
  ports.readAuthErasureSource = async (input) => {
    const source = await read(input);
    original = source;
    if (++reads === 2) await paused;
    return source;
  };
  try {
    const person = await f.person('history_phase_guard');
    await f.host.service.internal.registerClient({
      clientId: 'history-phase-delete',
      firstParty: true,
      scopes: [...scopes, 'account:delete'],
    });
    const signin = await f.request('/signin', {
      email: 'history_phase_guard@ordinary.test',
      password,
      client_id: 'history-phase-delete',
      scope: [...scopes, 'account:delete'],
    });
    expect(signin.status).toBe(200);
    const headers = cookies(signin);
    const operation = { kind: 'delete', accountId: person.accountId };
    const operationKey = 'phase-guard-delete';
    const approval = await f.request('/account-operations/approve', { operationKey, operation }, headers);
    expect(approval.status).toBe(200);
    const { reference } = (await approval.json()) as { reference: string };
    const deletion = f.request('/account-operations/execute', { operationKey, operation, reference }, headers);
    await eventually(async () => reads === 2);
    const source = original!;
    const root = { accountId: source.accountId, version: source.version, at: source.at };
    const fixed = createAuthHistoryProofBindings(db.pool);
    expect(await readAuthNativeConsumption(db.pool, source)).toBe(false);
    await expect(fixed.recordAuthHistoryCompletion(root)).rejects.toThrow('denied');
    expect(
      (
        await f.authPool.query('SELECT source_accepted_at,source_discharged_at FROM auth_erasure WHERE account_id=$1', [
          person.accountId,
        ])
      ).rows[0],
    ).toMatchObject({ source_accepted_at: expect.any(Date), source_discharged_at: null });
    const foreign = createAuthBindings({ pool: db.pool });
    await expect(foreign.recordAuthNativeConsumption!(source)).rejects.toThrow('unavailable');
    release();
    expect((await deletion).status).toBe(200);
    expect(await readAuthNativeConsumption(db.pool, source)).toBe(true);
    expect(await readAuthHistoryCompletion(db.pool, root)).toBe(false);
    await fixed.recordAuthNativeConsumption(source);
    expect(
      (
        await db.admin.query('SELECT phase FROM access.auth_history_proof WHERE route=$1 AND account_id=$2', [
          routeOf(person.accountId),
          person.accountId,
        ])
      ).rows,
    ).toEqual([{ phase: 'native-consumed' }]);
  } finally {
    release();
    ports.readAuthErasureSource = read;
    await f.close();
    await db.close();
  }
}, 180000);
