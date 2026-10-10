import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { isForegroundOperation } from '../../../tests/qa/integration/support/operation-cost.ts';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { currentWorkerTick } from '../src/worker-tick.ts';
import { RealmReplyDenied } from '../src/modules/realm-reply/content-store.ts';
import { TargetUnavailable } from '../src/modules/target/resolve.ts';
import { growRealmThreads } from './g-1034-fixture.ts';
import { realmVisibilityFixture } from './realm-visibility-fixture.ts';

/** Query executions and Fuseki requests for one reply: draft, identity, review, placement.
 * The ceiling is the whole reply. Each bucket is exactly the same at both Realm sizes. */
export const REALM_REPLY_WRITE_COST = {
  statements: 840,
  fusekiRequests: 130,
} as const;

/** True only while the measured request is the foreground caller. Background
 * schedulers and other work on these pools are not this request's cost. */
const measuredRequest = new AsyncLocalStorage<true>();
function foregroundCounted(): boolean {
  return measuredRequest.getStore() === true && isForegroundOperation() && currentWorkerTick() === undefined;
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

type Count = { statements: number; fusekiRequests: number; content: number; access: number; account: number };
type ReplyCost = Count & { ms: number; commands: Record<string, Count & { ms: number }> };

function tallyPool(pool: Pool) {
  let count = 0;
  const seen = new WeakSet<object>();
  const connect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  const wrap = (client: PoolClient) => {
    if (seen.has(client)) return;
    seen.add(client);
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    client.query = ((...args: unknown[]) => {
      if (foregroundCounted()) count += 1;
      return query(...args);
    }) as PoolClient['query'];
  };
  pool.connect = ((...args: unknown[]) => {
    if (typeof args[0] === 'function') {
      const callback = args[0] as (error: Error | undefined, client: PoolClient, done: () => void) => void;
      return connect((error: Error | undefined, client: PoolClient, done: () => void) => {
        if (client) wrap(client);
        callback(error, client, done);
      });
    }
    return Promise.resolve(connect()).then((client) => {
      wrap(client as PoolClient);
      return client;
    });
  }) as Pool['connect'];
  return { get count() { return count }, reset() { count = 0 } };
}

function tallyFuseki(fuseki: FusekiClient) {
  let count = 0;
  for (const method of ['query', 'update', 'command', 'commandWithReceipt', 'commandHealth'] as const) {
    const original = fuseki[method].bind(fuseki) as (...args: unknown[]) => unknown;
    (fuseki as unknown as Record<string, (...args: unknown[]) => unknown>)[method] = (...args: unknown[]) => {
      if (foregroundCounted()) count += 1;
      return original(...args);
    };
  }
  return { get count() { return count }, reset() { count = 0 } };
}

test('one reply costs the same statements and Fuseki requests at 100 and 1,000 threads', async () => {
  const fx = await realmVisibilityFixture();
  try {
    await fx.grant(fx.actor, `review:decide:${fx.realm}`, 'review.decide');
    await fx.grant(fx.actor, `reply:place:${fx.realm}`, 'reply.place');
    const statements = tallyPool(fx.contentPool);
    const access = tallyPool(fx.accessPool);
    const accounts = tallyPool(fx.accountPool);
    const fuseki = tallyFuseki(fx.fuseki);
    const read = (): Count & { content: number; access: number; account: number } => ({
      statements: statements.count + access.count + accounts.count,
      fusekiRequests: fuseki.count,
      content: statements.count, access: access.count, account: accounts.count,
    });
    const reset = () => { statements.reset(); access.reset(); accounts.reset(); fuseki.reset(); };
    const postReply = async (): Promise<{ reply: string; cost: ReplyCost }> => {
      const input = fx.draftInput();
      const commands: ReplyCost['commands'] = {};
      const started = Date.now();
      const step = async (name: string, path: string, body: object) => {
        reset();
        const at = Date.now();
        const response = await measuredRequest.run(true, () => fx.call('POST', path, body));
        commands[name] = { ...read(), ms: Date.now() - at };
        expect(response.status, `${name} ${JSON.stringify(response.body)}`).toBe(201);
        return response.body;
      };
      const draft = await step('draft', '/v1/member-reply-drafts', input);
      const identity = await step('identity', '/v1/realm-replies', {
        profile: 'realm-reply-identity-v1', reply: input.reply, variantId: input.variantId,
        revisionId: draft.revisionId, author: fx.actor, rootTarget: input.rootTarget,
        rootRevision: input.rootRevision, parentReply: null, parentRevision: null, contextRevision: null,
      });
      const review = await step('review', '/v1/realm-reply-reviews', {
        profile: 'realm-reply-review-v1', realm: fx.realm, reply: input.reply,
        revisionId: draft.revisionId, revisionDigest: draft.revisionDigest, expectedGeneration: '0',
        supersedes: null, outcome: 'approved', method: 'human', methodRevision: 'realm-manager-v1',
        dependencyDigest: sha(fx.work.work), reasonReference: null, actingSubject: fx.actor,
      });
      await step('placement', '/v1/realm-reply-placements', {
        profile: 'realm-reply-placement-v1', realm: fx.realm, reply: input.reply,
        revisionId: draft.revisionId, revisionDigest: draft.revisionDigest,
        reviewDecisionId: review.decisionId, expectedHead: null, actingSubject: fx.actor,
      });
      const cost = {
        statements: Object.values(commands).reduce((sum, command) => sum + command.statements, 0),
        fusekiRequests: Object.values(commands).reduce((sum, command) => sum + command.fusekiRequests, 0),
        content: Object.values(commands).reduce((sum, command) => sum + command.content, 0),
        access: Object.values(commands).reduce((sum, command) => sum + command.access, 0),
        account: Object.values(commands).reduce((sum, command) => sum + command.account, 0),
        ms: Date.now() - started, commands,
      };
      return { reply: identity.reply as string, cost };
    };

    const source = await postReply();
    await growRealmThreads(fx.contentPool, fx.accessPool, fx.env, fx.realm, source.reply, 0, 99, undefined, false);
    await postReply();
    const at100 = (await postReply()).cost;
    await growRealmThreads(fx.contentPool, fx.accessPool, fx.env, fx.realm, source.reply, 99, 899, undefined, false);
    await postReply();
    const at1000 = (await postReply()).cost;
    console.log(JSON.stringify({ realmReplyWriteCost: { at100, at1000 } }));
    const counted = (cost: ReplyCost) => ({
      statements: cost.statements, fusekiRequests: cost.fusekiRequests,
      content: cost.content, access: cost.access, account: cost.account,
      commands: Object.fromEntries(Object.entries(cost.commands).map(([name, command]) => [name, {
        statements: command.statements, fusekiRequests: command.fusekiRequests,
        content: command.content, access: command.access, account: command.account,
      }])),
    });
    expect(counted(at1000), JSON.stringify({ at100, at1000 })).toEqual(counted(at100));
    for (const cost of [at100, at1000]) {
      expect(cost.statements).toBeGreaterThan(0);
      expect(cost.fusekiRequests).toBeGreaterThan(0);
      expect(cost.statements).toBeLessThanOrEqual(REALM_REPLY_WRITE_COST.statements);
      expect(cost.fusekiRequests).toBeLessThanOrEqual(REALM_REPLY_WRITE_COST.fusekiRequests);
    }

    const original = fx.fuseki.commandWithReceipt.bind(fx.fuseki);
    let failCancels = 0;
    fx.fuseki.commandWithReceipt = async (envelope) => {
      if (failCancels > 0 && envelope.update.includes('rv:outcome rv:Cancelled')) {
        failCancels -= 1;
        throw new Error('placement cancellation transport failed');
      }
      return original(envelope);
    };
    const poisoned = fx.draftInput();
    const poisonedDraft = await fx.call('POST', '/v1/member-reply-drafts', poisoned);
    expect(poisonedDraft.status, JSON.stringify(poisonedDraft.body)).toBe(201);
    const poisonedKey = randomUUID();
    failCancels = 1;
    const lost = await fx.call('POST', '/v1/realm-replies', {
      profile: 'realm-reply-identity-v1', reply: poisoned.reply, variantId: poisoned.variantId,
      revisionId: poisonedDraft.body.revisionId, author: fx.actor, rootTarget: poisoned.rootTarget,
      rootRevision: poisoned.rootRevision, parentReply: `https://rezics.com/id/${randomUUID()}`,
      parentRevision: randomUUID(), contextRevision: null,
    }, fx.actor, poisonedKey);
    expect(lost.status, JSON.stringify(lost.body)).toBe(503);
    const admission = await fx.accessPool.query<{ id: string }>(
      `SELECT id FROM access.admission WHERE idempotency_key = $1 AND action = 'reply.create'`, [poisonedKey]);
    expect(admission.rowCount).toBe(1);
    const receipt = await fx.contentPool.query<{ outcome: string }>(
      'SELECT outcome FROM content.receipt WHERE operation_id = $1', [admission.rows[0]!.id]);
    expect(receipt.rows[0]?.outcome).toBe('rejected');
    const next = await postReply();
    expect(next.reply.startsWith('https://rezics.com/id/')).toBe(true);
  } finally {
    await fx.close();
  }
}, 420_000);

test('a same-key create during cancellation cannot leave a live identity under a cancelled graph', async () => {
  const fx = await realmVisibilityFixture();
  const query = fx.fuseki.query.bind(fx.fuseki);
  const command = fx.fuseki.commandWithReceipt.bind(fx.fuseki);
  try {
    const draftInput = fx.draftInput();
    const draft = await fx.call('POST', '/v1/member-reply-drafts', draftInput);
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const body = {
      profile: 'realm-reply-identity-v1', reply: draftInput.reply, variantId: draftInput.variantId,
      revisionId: draft.body.revisionId, author: fx.actor, rootTarget: draftInput.rootTarget,
      rootRevision: draftInput.rootRevision, parentReply: null, parentRevision: null, contextRevision: null,
    };
    const key = randomUUID();
    const arm = { on: false };
    let failedRoot = false;
    let pausedCancel = false;
    let releaseCancel = () => {};
    const cancelPaused = new Promise<void>(resolve => {
      const connect = fx.accessPool.connect.bind(fx.accessPool) as (...args: unknown[]) => unknown;
      const seen = new WeakSet<object>();
      const wrap = (client: PoolClient) => {
        if (seen.has(client)) return;
        seen.add(client);
        const original = client.query.bind(client) as (...args: unknown[]) => unknown;
        client.query = ((...args: unknown[]) => {
          const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string } | undefined)?.text;
          if (typeof text === 'string' && text.includes("'admission.claimed'")) arm.on = true;
          return original(...args);
        }) as PoolClient['query'];
      };
      fx.accessPool.connect = ((...args: unknown[]) => {
        if (typeof args[0] === 'function') {
          const callback = args[0] as (error: Error | undefined, client: PoolClient, done: () => void) => void;
          return connect((error: Error | undefined, client: PoolClient, done: () => void) => {
            if (client) wrap(client);
            callback(error, client, done);
          });
        }
        return Promise.resolve(connect()).then(client => {
          wrap(client as PoolClient);
          return client;
        });
      }) as Pool['connect'];
      resolve();
    });
    await cancelPaused;
    fx.fuseki.query = async (sparql, limit) => {
      if (arm.on && !failedRoot && sparql.includes('rv:ErasedRevision')) {
        failedRoot = true;
        // An authority refusal still cancels. A dependency failure must not.
        throw new RealmReplyDenied('parent is not an exact reply');
      }
      return query(sparql, limit);
    };
    const release = new Promise<void>(resolve => { releaseCancel = resolve; });
    fx.fuseki.commandWithReceipt = async (envelope) => {
      if (!pausedCancel && envelope.update.includes('rv:outcome rv:Cancelled')) {
        pausedCancel = true;
        await release;
      }
      return command(envelope);
    };
    const canceller = fx.call('POST', '/v1/realm-replies', body, fx.actor, key);
    const started = Date.now();
    while (!pausedCancel) {
      if (Date.now() - started > 60_000) throw new Error('cancellation did not reach the graph command');
      await Bun.sleep(20);
    }
    const racer = await fx.call('POST', '/v1/realm-replies', body, fx.actor, key);
    releaseCancel();
    const cancelled = await canceller;
    expect(racer.status, JSON.stringify(racer.body)).not.toBe(201);
    expect(cancelled.status, JSON.stringify(cancelled.body)).not.toBe(201);
    const admission = await fx.accessPool.query<{ id: string; graph_outcome: string | null }>(
      `SELECT id, graph_outcome FROM access.admission WHERE idempotency_key = $1 AND action = 'reply.create'`, [key]);
    expect(admission.rowCount).toBe(1);
    const receipt = await fx.contentPool.query<{ outcome: string }>(
      'SELECT outcome FROM content.receipt WHERE operation_id = $1', [admission.rows[0]!.id]);
    const live = await fx.contentPool.query('SELECT 1 FROM content.reply WHERE id = $1', [body.reply]);
    const identity = receipt.rows[0]?.outcome === 'succeeded' && (live.rowCount ?? 0) > 0;
    expect(admission.rows[0]!.graph_outcome === 'cancelled' && identity).toBe(false);
    expect(receipt.rows[0]?.outcome).toBe('rejected');
    expect(live.rowCount).toBe(0);
    expect(admission.rows[0]!.graph_outcome).toBe('cancelled');
  } finally {
    fx.fuseki.query = query;
    fx.fuseki.commandWithReceipt = command;
    await fx.close();
  }
}, 120_000);

test('a transient target unavailability leaves the same identity key retryable', async () => {
  const fx = await realmVisibilityFixture();
  const query = fx.fuseki.query.bind(fx.fuseki);
  const previousConnect = fx.accessPool.connect;
  try {
    const draftInput = fx.draftInput();
    const draft = await fx.call('POST', '/v1/member-reply-drafts', draftInput);
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const body = {
      profile: 'realm-reply-identity-v1', reply: draftInput.reply, variantId: draftInput.variantId,
      revisionId: draft.body.revisionId, author: fx.actor, rootTarget: draftInput.rootTarget,
      rootRevision: draftInput.rootRevision, parentReply: null, parentRevision: null, contextRevision: null,
    };
    const key = randomUUID();
    const arm = { on: false };
    let failed = false;
    const connect = fx.accessPool.connect.bind(fx.accessPool) as (...args: unknown[]) => unknown;
    const seen = new WeakSet<object>();
    const wrap = (client: PoolClient) => {
      if (seen.has(client)) return;
      seen.add(client);
      const original = client.query.bind(client) as (...args: unknown[]) => unknown;
      client.query = ((...args: unknown[]) => {
        const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string } | undefined)?.text;
        if (typeof text === 'string' && text.includes("'admission.claimed'")) arm.on = true;
        return original(...args);
      }) as PoolClient['query'];
    };
    fx.accessPool.connect = ((...args: unknown[]) => {
      if (typeof args[0] === 'function') {
        const callback = args[0] as (error: Error | undefined, client: PoolClient, done: () => void) => void;
        return connect((error: Error | undefined, client: PoolClient, done: () => void) => {
          if (client) wrap(client);
          callback(error, client, done);
        });
      }
      return Promise.resolve(connect()).then(client => {
        wrap(client as PoolClient);
        return client;
      });
    }) as Pool['connect'];
    fx.fuseki.query = async (sparql, limit) => {
      if (arm.on && !failed && sparql.includes('rv:ErasedRevision')) {
        failed = true;
        throw new TargetUnavailable();
      }
      return query(sparql, limit);
    };
    const first = await fx.call('POST', '/v1/realm-replies', body, fx.actor, key);
    expect(first.status, JSON.stringify(first.body)).toBe(503);
    const admission = await fx.accessPool.query<{ id: string; graph_outcome: string | null }>(
      `SELECT id, graph_outcome FROM access.admission WHERE idempotency_key = $1 AND action = 'reply.create'`, [key]);
    expect(admission.rowCount).toBe(1);
    expect(admission.rows[0]!.graph_outcome).toBeNull();
    const rejected = await fx.contentPool.query(
      `SELECT 1 FROM content.receipt WHERE operation_id = $1 AND outcome = 'rejected'`, [admission.rows[0]!.id]);
    expect(rejected.rowCount).toBe(0);
    const retry = await fx.call('POST', '/v1/realm-replies', body, fx.actor, key);
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    const live = await fx.contentPool.query('SELECT 1 FROM content.reply WHERE id = $1', [body.reply]);
    expect(live.rowCount).toBe(1);
  } finally {
    fx.accessPool.connect = previousConnect;
    fx.fuseki.query = query;
    await fx.close();
  }
}, 120_000);

test('an unreadable reply root writes no admission, receipt, or graph command', async () => {
  const fx = await realmVisibilityFixture();
  const command = fx.fuseki.command.bind(fx.fuseki);
  const withReceipt = fx.fuseki.commandWithReceipt.bind(fx.fuseki);
  let commands = 0;
  fx.fuseki.command = (async (...args: Parameters<FusekiClient['command']>) => {
    commands += 1;
    return command(...args);
  }) as FusekiClient['command'];
  fx.fuseki.commandWithReceipt = (async (...args: Parameters<FusekiClient['commandWithReceipt']>) => {
    commands += 1;
    return withReceipt(...args);
  }) as FusekiClient['commandWithReceipt'];
  try {
    const key = randomUUID();
    const response = await fx.call('POST', '/v1/realm-replies', {
      profile: 'realm-reply-identity-v1', reply: `https://rezics.com/id/${randomUUID()}`,
      variantId: `urn:rezics:variant:${randomUUID()}`, revisionId: randomUUID(), author: fx.actor,
      rootTarget: `https://rezics.com/id/${randomUUID()}`, rootRevision: `https://rezics.com/id/${randomUUID()}`,
      parentReply: null, parentRevision: null, contextRevision: null,
    }, fx.actor, key);
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(commands).toBe(0);
    const admission = await fx.accessPool.query<{ id: string }>(
      `SELECT id FROM access.admission WHERE idempotency_key = $1`, [key]);
    expect(admission.rowCount).toBe(0);
    const receipt = admission.rows[0]
      ? await fx.contentPool.query('SELECT 1 FROM content.receipt WHERE operation_id = $1', [admission.rows[0].id])
      : { rowCount: 0 };
    expect(receipt.rowCount).toBe(0);
  } finally {
    fx.fuseki.command = command;
    fx.fuseki.commandWithReceipt = withReceipt;
    await fx.close();
  }
}, 120_000);

function sqlText(args: unknown[]): string | undefined {
  const first = args[0];
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object' && 'text' in first && typeof first.text === 'string') return first.text;
  return undefined;
}

function sqlValues(args: unknown[]): unknown[] {
  const first = args[0];
  if (typeof first === 'string') return Array.isArray(args[1]) ? args[1] as unknown[] : [];
  if (first && typeof first === 'object' && 'values' in first && Array.isArray(first.values)) return first.values as unknown[];
  return [];
}

/** The placement callback holds the admission until the claim after the pin
 * commits. Another connection cannot change that row in time for the claim to
 * see it, so the change runs on the claim's own client. */
function armSecondClaim(access: Pool, content: Pool,
  change: (query: PoolClient['query'], admissionId: string) => Promise<void>): () => void {
  const restore: Array<() => void> = [];
  const wrap = (pool: Pool, install: (query: (...args: unknown[]) => unknown) => PoolClient['query']) => {
    const connect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
    const seen = new WeakSet<object>();
    const wrapClient = (client: PoolClient) => {
      if (seen.has(client)) return;
      seen.add(client);
      const query = client.query.bind(client) as (...args: unknown[]) => unknown;
      client.query = install(query);
    };
    pool.connect = ((...args: unknown[]) => {
      if (typeof args[0] === 'function') {
        const callback = args[0] as (error: Error | undefined, client: PoolClient, done: () => void) => void;
        return connect((error: Error | undefined, client: PoolClient, done: () => void) => {
          if (client) wrapClient(client);
          callback(error, client, done);
        });
      }
      return Promise.resolve(connect()).then(client => {
        wrapClient(client as PoolClient);
        return client;
      });
    }) as Pool['connect'];
    restore.push(() => { pool.connect = connect as Pool['connect']; });
  };
  let prepared = false;
  let changed = false;
  wrap(content, query => ((...args: unknown[]) => {
    const pending = query(...args);
    if (prepared || !sqlText(args)?.includes('INSERT INTO content.publication_preparation')) return pending;
    return Promise.resolve(pending).then(value => {
      prepared = true;
      return value;
    });
  }) as PoolClient['query']);
  wrap(access, query => ((...args: unknown[]) => {
    const text = sqlText(args);
    if (!changed && prepared && text?.includes('SELECT scope_id, action FROM access.admission WHERE id')) {
      changed = true;
      const admissionId = String(sqlValues(args)[0]);
      return Promise.resolve(change(query as PoolClient['query'], admissionId)).then(() => query(...args));
    }
    return query(...args);
  }) as PoolClient['query']);
  return () => { for (const undo of restore) undo(); };
}

async function reviewedPlacement(fx: Awaited<ReturnType<typeof realmVisibilityFixture>>) {
  await fx.grant(fx.actor, `review:decide:${fx.realm}`, 'review.decide');
  await fx.grant(fx.actor, `reply:place:${fx.realm}`, 'reply.place');
  const input = fx.draftInput();
  const draft = await fx.call('POST', '/v1/member-reply-drafts', input);
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  const identity = await fx.call('POST', '/v1/realm-replies', {
    profile: 'realm-reply-identity-v1', reply: input.reply, variantId: input.variantId,
    revisionId: draft.body.revisionId, author: fx.actor, rootTarget: input.rootTarget,
    rootRevision: input.rootRevision, parentReply: null, parentRevision: null, contextRevision: null,
  });
  expect(identity.status, JSON.stringify(identity.body)).toBe(201);
  const review = await fx.call('POST', '/v1/realm-reply-reviews', {
    profile: 'realm-reply-review-v1', realm: fx.realm, reply: input.reply,
    revisionId: draft.body.revisionId, revisionDigest: draft.body.revisionDigest, expectedGeneration: '0',
    supersedes: null, outcome: 'approved', method: 'human', methodRevision: 'realm-manager-v1',
    dependencyDigest: sha(fx.work.work), reasonReference: null, actingSubject: fx.actor,
  });
  expect(review.status, JSON.stringify(review.body)).toBe(201);
  return {
    profile: 'realm-reply-placement-v1', realm: fx.realm, reply: input.reply,
    revisionId: draft.body.revisionId, revisionDigest: draft.body.revisionDigest,
    reviewDecisionId: review.body.decisionId, expectedHead: null, actingSubject: fx.actor,
  };
}

async function expectRefusedPlacement(fx: Awaited<ReturnType<typeof realmVisibilityFixture>>,
  body: Awaited<ReturnType<typeof reviewedPlacement>>, key: ReturnType<typeof randomUUID>, status: number) {
  const first = await fx.call('POST', '/v1/realm-reply-placements', body, fx.actor, key);
  expect(first.status, JSON.stringify(first.body)).toBe(status);
  const admission = await fx.accessPool.query<{ id: string; state: string; graph_outcome: string | null }>(
    `SELECT id, state, graph_outcome FROM access.admission WHERE idempotency_key = $1 AND action = 'reply.place'`, [key]);
  expect(admission.rowCount).toBe(1);
  expect(admission.rows[0]).toMatchObject({ state: 'sealed', graph_outcome: 'cancelled' });
  const pin = await fx.contentPool.query<{ status: string; pin_active: boolean }>(
    'SELECT status, pin_active FROM content.publication_preparation WHERE operation_id = $1',
    [admission.rows[0]!.id]);
  expect(pin.rows).toEqual([{ status: 'rejected', pin_active: false }]);
  const retry = await fx.call('POST', '/v1/realm-reply-placements', body, fx.actor, key);
  expect(retry.status, JSON.stringify(retry.body)).not.toBe(503);
  expect([403, 409]).toContain(retry.status);
  const again = await fx.accessPool.query<{ state: string; graph_outcome: string | null }>(
    'SELECT state, graph_outcome FROM access.admission WHERE id = $1', [admission.rows[0]!.id]);
  expect(again.rows[0]).toMatchObject({ state: 'sealed', graph_outcome: 'cancelled' });
}

test('an expired admission retry is refused and sealed with the placement pin released', async () => {
  const fx = await realmVisibilityFixture();
  let restore = () => {};
  try {
    const body = await reviewedPlacement(fx);
    const key = randomUUID();
    restore = armSecondClaim(fx.accessPool, fx.contentPool, (query, admissionId) => query(
      `UPDATE access.admission SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
      [admissionId]).then(() => undefined));
    await expectRefusedPlacement(fx, body, key, 409);
  } finally {
    restore();
    await fx.close();
  }
}, 120_000);

test('a revoked authority epoch retry is refused and sealed with the placement pin released', async () => {
  const fx = await realmVisibilityFixture();
  let restore = () => {};
  try {
    const body = await reviewedPlacement(fx);
    const key = randomUUID();
    restore = armSecondClaim(fx.accessPool, fx.contentPool, query => query(
      'UPDATE access.scope_gate SET authority_epoch = authority_epoch + 1 WHERE id = $1',
      [`reply:place:${fx.realm}`]).then(() => undefined));
    await expectRefusedPlacement(fx, body, key, 403);
  } finally {
    restore();
    await fx.close();
  }
}, 120_000);
