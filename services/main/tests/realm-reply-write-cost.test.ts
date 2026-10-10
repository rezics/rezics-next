import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { RealmReplyDenied } from '../src/modules/realm-reply/content-store.ts';
import { TargetUnavailable } from '../src/modules/target/resolve.ts';
import { growRealmThreads } from './g-1034-fixture.ts';
import { realmVisibilityFixture } from './realm-visibility-fixture.ts';

/** Query executions and Fuseki requests for one reply: draft, identity, review, placement.
 * Content and account statements are identical at both sizes. Access and Fuseki
 * probes vary by a few retries that do not grow with the Realm; the slack is far
 * below one extra probe per thread. */
export const REALM_REPLY_WRITE_COST = {
  statements: 840,
  fusekiRequests: 130,
  statementJitter: 32,
  fusekiJitter: 16,
} as const;

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
      count += 1;
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
      count += 1;
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
        const response = await fx.call('POST', path, body);
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
    const stable = (cost: ReplyCost) => Object.fromEntries(Object.entries(cost.commands).map(([name, command]) =>
      [name, { content: command.content, account: command.account }]));
    expect(stable(at1000), JSON.stringify({ at100, at1000 })).toEqual(stable(at100));
    for (const name of Object.keys(at100.commands)) {
      const smaller = at100.commands[name]!;
      const larger = at1000.commands[name]!;
      expect(Math.abs(smaller.statements - larger.statements), name).toBeLessThanOrEqual(REALM_REPLY_WRITE_COST.statementJitter);
      expect(Math.abs(smaller.fusekiRequests - larger.fusekiRequests), name).toBeLessThanOrEqual(REALM_REPLY_WRITE_COST.fusekiJitter);
    }
    expect(Math.abs(at100.statements - at1000.statements)).toBeLessThanOrEqual(8);
    expect(Math.abs(at100.fusekiRequests - at1000.fusekiRequests)).toBeLessThanOrEqual(4);
    for (const cost of [at100, at1000]) {
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
