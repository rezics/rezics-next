import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../../../scripts/database.ts';
import { dropTestDatabase } from '../../support/drop-test-database.ts';
import { runCommand } from '../../../src/command/command.ts';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../../src/access/bootstrap-governance.ts';
import { createAgentVerificationCommands, readAgentVerificationWorkflowRequest, recordPendingAgentVerification } from '../../../src/access/agent-verification.ts';
import { createRealAccess } from '../real-access.ts';
import { newId, routeOf } from '../../../src/route/route.ts';
import { createSubject } from '../../../src/semantic/subject.ts';
import type {
  IdentityEpochStore,
  IdentityIntent,
  IdentityJobRef,
  IdentityReceipt,
} from '../../../src/semantic/identity-epoch-contract.ts';
import { digest, epochFixture, release, type EpochFixture } from './identity-epoch.ts';

/** Own the database we perturb. Never fence, drop or stop a neighbour's resource. */
export async function cutoverFixture() {
  const source = process.env.DATABASE_URL;
  if (!source) throw new Error('DATABASE_URL must name the migrated test database');
  const admin = new pg.Pool({ connectionString: source, max: 1 });
  const name = `identity_cutover_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(source);
  url.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  try {
    migrate(url.toString());
    // epochFixture reads DATABASE_URL synchronously before its first await. Restore it immediately;
    // only the returned real pools retain the owned URL. No owner result or readiness is substituted.
    let pending: ReturnType<typeof epochFixture>;
    process.env.DATABASE_URL = url.toString();
    try {
      pending = epochFixture();
    } finally {
      process.env.DATABASE_URL = source;
    }
    const fixture = await pending;
    return {
      ...fixture,
      async close() {
        try {
          await fixture.close();
        } finally {
          try {
            await dropTestDatabase(admin, name);
          } finally {
            await admin.end();
          }
        }
      },
    };
  } catch (error) {
    try {
      await dropTestDatabase(admin, name);
    } finally {
      await admin.end();
    }
    throw error;
  }
}

export async function birthAt(f: EpochFixture, id: string) {
  const key = randomUUID();
  return createSubject(f.pool, {
    actor: await f.actor(),
    target: { route: routeOf(id)!, id },
    item: { type: 'schema:Person', labels: { en: 'Native cutover original' } },
    idempotencyKey: key,
    digest: digest(key),
    release,
    authorization: await f.authorization('subject:create'),
  });
}

export async function ordinaryAdmission(f: EpochFixture, store: IdentityEpochStore, intent: IdentityIntent) {
  const actor = await f.actor();
  const key = randomUUID();
  const receipt: IdentityReceipt = {
    kind: 'subject.merge',
    command: { actorAccountId: actor.accountId, kind: 'subject.merge', key, digest: digest(key) },
  };
  return {
    receipt,
    execute: async (next = intent) =>
      runCommand(
        f.pool,
        {
          partition: store.controlPartition,
          basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
          authorization: await f.authorization('subject:merge'),
        },
        (tx) => store.admit(tx, { intent: next, receipt }),
      ),
  };
}

/** Fixture population ONLY: a legacy original in a home not selected by the requested endpoints. */
export async function crossHomeLegacy(f: EpochFixture, terminal: string, route: number) {
  const original = newId(route);
  const tx = await f.admin.connect();
  try {
    await tx.query('BEGIN');
    const native = randomUUID();
    await tx.query(
      `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id,current_facts,current_release)
       VALUES ($1,$2,'schema:Person',$3,0,$4)`,
      [route, original, native, release.digest],
    );
    await tx.query(
      `INSERT INTO semantic.revision(route,subject_id,revision,kind,release,recorded_transaction_id)
       VALUES ($1,$2,1,'create',$3,$4),($1,$2,2,'merge',$3,$4)`,
      [route, original, release.digest, native],
    );
    await tx.query(
      'INSERT INTO semantic.redirect(route,subject_id,sequence,target,recorded_transaction_id) VALUES ($1,$2,1,$3,$4)',
      [route, original, terminal, native],
    );
    await tx.query(
      `INSERT INTO semantic.merge_member(route,subject_id,member_id,phase,cursor)
       VALUES ($1,$2,$3,'links','[]'::jsonb)`,
      [routeOf(terminal), terminal, original],
    );
    await tx.query('COMMIT');
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
  return original;
}

export async function allChanges(f: EpochFixture, store: IdentityEpochStore, job: IdentityJobRef) {
  const changes = [];
  let after: string | null = null;
  for (let page = 0; page < 100; page++) {
    const value = await store.pageChanges(f.pool, job, after);
    expect(value.changes.length).toBeLessThanOrEqual(100);
    expect(value.changes.every((change) => after === null || change.original > after)).toBe(true);
    expect(await store.pageChanges(f.pool, job, after), 'immutable page replay').toEqual(value);
    changes.push(...value.changes);
    if (value.next === null) return changes;
    expect(value.next > (after ?? '')).toBe(true);
    after = value.next;
  }
  throw new Error('Finite capped affected input failed to exhaust in 100 bounded pages');
}

/** Exact native owner perturbation on OUR database; this is a failure, never a readiness producer. */
export async function withoutOwner<T>(f: EpochFixture, partition: number, work: () => Promise<T>) {
  const { rows: [owner] } = await f.admin.query('DELETE FROM core.partition WHERE partition_no=$1 RETURNING *', [partition]);
  expect(owner).toBeDefined();
  try {
    return await work();
  } finally {
    await f.admin.query('INSERT INTO core.partition SELECT * FROM jsonb_populate_record(NULL::core.partition,$1::jsonb)', [JSON.stringify(owner)]);
  }
}

/** Observe and schedule real pg statements without replacing data, receipts or owner answers.
 * The pause is at a connection release, before the same lookup's next checkout. Admission uses
 * a separate async context and is never intercepted. Existing pool nested-checkout checks still run.
 */
export async function afterSourceRelease<T>(
  f: EpochFixture,
  lookup: () => Promise<T>,
  between: () => Promise<void>,
): Promise<T> {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const context = new AsyncLocalStorage<boolean>();
  let released = false;
  let sourceObserved = false;
  let held = 0;
  const reached = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const statements: string[] = [];
  const wrapped = new Map<pg.PoolClient, pg.PoolClient['query']>();
  const acquire = (client: pg.PoolClient) => {
    if (!context.getStore()) return;
    held++;
    if (wrapped.has(client)) return;
    const query = client.query;
    wrapped.set(client, query);
    client.query = new Proxy(query, {
      apply(target, self, args: unknown[]) {
        if (context.getStore()) {
          const input = args[0];
          const sql = typeof input === 'string' ? input : (input as { text?: string })?.text ?? '';
          statements.push(sql);
          if (/identity_epoch_mapping/i.test(sql)) sourceObserved = true;
        }
        return Reflect.apply(target, self, args);
      },
    });
  };
  const release = () => {
    if (!context.getStore()) return;
    held--;
    if (sourceObserved && !released) {
      released = true;
      reached.resolve();
    }
  };
  // connect is the actual existing pool function, including its nested checkout guard.
  const connect = f.pool.connect;
  f.pool.connect = new Proxy(connect, {
    apply(target, self, args: unknown[]) {
      if (context.getStore() && released) {
        return proceed.promise.then(() => Reflect.apply(target, self, args));
      }
      return Reflect.apply(target, self, args);
    },
  });
  f.pool.on('acquire', acquire);
  f.pool.on('release', release);
  const result = context.run(true, lookup);
  // Surface early lookup failure instead of hanging a schedule on an unimplemented query path.
  const ended = result.then(() => 'ended' as const, () => 'ended' as const);
  try {
    expect(await Promise.race([reached.promise.then(() => 'released' as const), ended]), 'lookup must reach actual source mapping read and release').toBe('released');
    expect(held, 'source connection must be released before control checkout').toBe(0);
    await between();
    proceed.resolve();
    const value = await result;
    console.info('native released mapping SQL', JSON.stringify(statements));
    return value;
  } finally {
    proceed.resolve();
    await result.catch(() => {});
    f.pool.connect = connect;
    f.pool.off('acquire', acquire);
    f.pool.off('release', release);
    for (const [client, query] of wrapped) client.query = query;
  }
}

/** Real Access request, decision and pending command; no caller-created verification receipt. */
export async function approvedVerification(f: EpochFixture, catalogue: string) {
  const accounts = { person: newId(0x9c10), staff: newId(0x9c20) };
  const actions = ['account:update', 'account:verify_agent'];
  const real = await createRealAccess(f.admin, accounts, actions);
  const access = real.access({ actions: new Map(actions.map((action) => [action, {}])) });
  await bootstrapGovernance(f.pool, accounts.staff);
  await real.grant({ route: routeOf(accounts.person)!, id: accounts.person }, 'person', 'account:update');
  await real.grant(PLATFORM_RESOURCE, 'staff', 'account:verify_agent');
  const clock = () => new Date();
  const commands = createAgentVerificationCommands({ pool: f.pool, access, clock });
  const context = async (persona: 'person' | 'staff') => ({
    pool: f.pool,
    deadline: Date.now() + 5000,
    actor: await access.authenticate(real.bearer(persona), { pool: f.pool, deadline: Date.now() + 5000 }),
  });
  const requested = await commands.request(await context('person'), {
    accountId: accounts.person, subject: catalogue, statement: 'This is my catalogue identity', links: [], key: randomUUID(),
  });
  const decided = await commands.approve(await context('staff'), { requestId: requested.value.id, key: randomUUID() });
  expect(decided.value.state).toBe('approving');
  const saved = await readAgentVerificationWorkflowRequest(f.pool, requested.value.id);
  expect(saved?.decisionReceiptId).toBe(decided.value.decisionReceiptId);
  if (!saved?.decisionReceiptId) throw new Error('Actual Access decision did not retain its native receipt');
  const workflow = { ...saved, receiptId: saved.decisionReceiptId };
  await recordPendingAgentVerification(f.pool, workflow, clock);
  return { account: accounts.person, workflow, commands, context, clock };
}

/** Pause AFTER a real native account-subject read, while its caller is in flight. Move ONLY our
 * control owner to unavailable. This tests the required retryable path, not a fabricated cutover ACK.
 * A future all-home handoff driver must additionally exercise the final source barrier/guard itself.
 */
export async function withInFlightControlMove<T>(f: EpochFixture, operation: () => Promise<T>) {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const context = new AsyncLocalStorage<boolean>();
  const reached = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  let paused = false;
  const wrapped = new Map<pg.PoolClient, pg.PoolClient['query']>();
  const acquire = (client: pg.PoolClient) => {
    if (!context.getStore() || wrapped.has(client)) return;
    const query = client.query;
    wrapped.set(client, query);
    client.query = new Proxy(query, {
      apply(target, self, args: unknown[]) {
        const input = args[0];
        const sql = typeof input === 'string' ? input : (input as { text?: string })?.text ?? '';
        const result = Reflect.apply(target, self, args);
        if (context.getStore() && !paused && /JOIN semantic\.subject AS subject/i.test(sql)) {
          paused = true;
          return Promise.resolve(result).then(async (value) => {
            reached.resolve();
            await proceed.promise;
            return value;
          });
        }
        return result;
      },
    });
  };
  f.pool.on('acquire', acquire);
  const result = context.run(true, operation).then(
    (value) => ({ state: 'success' as const, value }),
    (error: unknown) => ({ state: 'unavailable' as const, error }),
  );
  let moved = false;
  try {
    expect(await Promise.race([reached.promise.then(() => 'native-read' as const), result.then(() => 'ended' as const)]),
      'in-flight schedule must reach actual owner SQL').toBe('native-read');
    // The existing fixed control home is Global (partition 0); source accounts are deliberately elsewhere.
    await f.admin.query("UPDATE core.partition SET write_state='moved',moved_to='cutover-test-node' WHERE partition_no=0");
    moved = true;
    proceed.resolve();
    return await result;
  } finally {
    proceed.resolve();
    await result;
    if (moved) await f.admin.query("UPDATE core.partition SET write_state='active',moved_to=NULL WHERE partition_no=0");
    f.pool.off('acquire', acquire);
    for (const [client, query] of wrapped) client.query = query;
  }
}

/** Real Library source commands. No canonical rows, directory readiness or ACKs are fixture-written. */
export async function libraryCutoverInput(f: EpochFixture, originals: readonly string[]) {
  const { createCollectionCommands } = await import('../../../src/library/collections.ts');
  const { createFollowCommands } = await import('../../../src/library/follows.ts');
  const { linkProjection } = await import('../../../src/semantic/links.ts');
  const { partitionOf } = await import('../../../src/route/route.ts');
  const accounts = { owner: newId(0xac10) };
  const actions = [
    'collection:create',
    'collection:read',
    'collection:update',
    'subject:read',
    'follow:create',
    'follow:delete',
  ];
  const real = await createRealAccess(f.admin, accounts, actions);
  const access = real.access({
    actions: new Map(
      actions.map((action) => [
        action,
        {
          anonymous: action === 'subject:read',
          ...(action === 'collection:create' ? { 'x-resource-types': ['library.collection'] } : {}),
        },
      ]),
    ),
  });
  const actor = () => access.authenticate(real.bearer('owner'), { pool: f.pool, deadline: Date.now() + 5000 });
  const commands = createCollectionCommands({ pool: f.pool, access });
  const follows = createFollowCommands({ pool: f.pool, access });
  const collection = (
    await commands.createCollection(
      await actor(),
      { title: 'Identity directory source', visibility: 'private' },
      randomUUID(),
    )
  ).value;
  const members = [];
  for (const original of originals) {
    const projection = linkProjection(f.pool);
    for (;;) {
      const progress = await projection.run(partitionOf(routeOf(original)!));
      expect(progress.status).toBe('read');
      if (progress.status !== 'read') throw new Error('Native Library source link projection unavailable');
      if (progress.envelopes === 0) break;
    }
    members.push(
      (
        await commands.addMember(
          await actor(),
          collection.id,
          { subjectId: original, note: 'Preserved original occurrence' },
          randomUUID(),
        )
      ).value,
    );
    await follows.follow(await actor(), { targetType: 'subject', targetId: original }, randomUUID());
  }
  return { collection, members, account: accounts.owner };
}

/** The already specified coordinator export, not a new participant callback or test scheduler. */
export async function nativeCutoverCoordinator() {
  const path = new URL('../../../src/semantic/identity-epoch-coordinator.ts', import.meta.url);
  const module = await import(path.href);
  return module.resumeIdentityEpochJob as import('../../../src/semantic/identity-epoch-contract.ts').ResumeIdentityEpochJob;
}

/** Pause the actual owner's SQL before dispatch. Only scheduling changes: no rows/receipts/results replaced.
 * If work ends before the requested native statement, fail at that actual boundary and never await a fake gate.
 */
export async function duringNativeSQL<T>(
  f: EpochFixture,
  pattern: RegExp,
  operation: () => Promise<T>,
  between: () => Promise<void>,
): Promise<T> {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const context = new AsyncLocalStorage<boolean>();
  const reached = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const wrapped = new Map<pg.PoolClient, pg.PoolClient['query']>();
  let paused = false;
  const acquire = (client: pg.PoolClient) => {
    if (!context.getStore() || wrapped.has(client)) return;
    const query = client.query;
    wrapped.set(client, query);
    client.query = new Proxy(query, {
      apply(target, self, args: unknown[]) {
        const input = args[0];
        const sql = typeof input === 'string' ? input : ((input as { text?: string })?.text ?? '');
        if (context.getStore() && !paused && pattern.test(sql)) {
          paused = true;
          console.info('native cutover interruption', sql);
          reached.resolve();
          return proceed.promise.then(() => Reflect.apply(target, self, args));
        }
        return Reflect.apply(target, self, args);
      },
    });
  };
  f.pool.on('acquire', acquire);
  const result = context.run(true, operation);
  const ended = result.then(
    () => 'ended' as const,
    () => 'ended' as const,
  );
  try {
    const boundary = await Promise.race([reached.promise.then(() => 'native-sql' as const), ended]);
    if (boundary === 'ended') await result; // Preserve the actual native failure in the raw output.
    expect(boundary, `native operation must reach ${pattern}`).toBe('native-sql');
    await between();
    proceed.resolve();
    return await result;
  } finally {
    proceed.resolve();
    await result.catch(() => {});
    f.pool.off('acquire', acquire);
    for (const [client, query] of wrapped) client.query = query;
  }
}

/** Native statement/returned-or-affected row observations, not a physical EXPLAIN budget certificate. */
export async function observeCutoverSQL<T>(f: EpochFixture, operation: () => Promise<T>) {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const context = new AsyncLocalStorage<boolean>();
  const queries: { sql: string; rows: number }[] = [];
  const wrapped = new Map<pg.PoolClient, pg.PoolClient['query']>();
  const acquire = (client: pg.PoolClient) => {
    if (!context.getStore() || wrapped.has(client)) return;
    const query = client.query;
    wrapped.set(client, query);
    client.query = new Proxy(query, {
      apply(target, self, args: unknown[]) {
        const measured = context.getStore();
        const input = args[0];
        const sql = typeof input === 'string' ? input : ((input as { text?: string })?.text ?? '');
        const result = Reflect.apply(target, self, args);
        if (!measured) return result;
        return Promise.resolve(result).then((value: pg.QueryResult) => {
          queries.push({ sql, rows: Math.max(value.rows?.length ?? 0, value.rowCount ?? 0) });
          return value;
        });
      },
    });
  };
  f.pool.on('acquire', acquire);
  try {
    return { value: await context.run(true, operation), queries };
  } finally {
    console.info('native cutover SQL observations', JSON.stringify(queries));
    f.pool.off('acquire', acquire);
    for (const [client, query] of wrapped) client.query = query;
  }
}
