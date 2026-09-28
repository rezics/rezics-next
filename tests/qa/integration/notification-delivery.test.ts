import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { NotificationDispatcher } from '../../../services/main/src/modules/notification/dispatcher.ts';
import { NotificationDeliveryWorker } from '../../../services/main/src/modules/notification/delivery-worker.ts';
import { HttpDeliveryProvider } from '../../../services/main/src/modules/notification/http-provider.ts';
import { NotificationStore, type NotificationEvent } from '../../../services/main/src/modules/notification/store.ts';
import { contentSubjectReader, contentWorkDisclosureBasis, currentContentSubjectReader }
  from '../../../services/main/src/modules/notification/subjects.ts';
import { NotificationRealtimeHub } from '../../../services/main/src/modules/notification/realtime.ts';
import { cloneQaOwnerDatabases, FakeDeliveryProvider, signProviderEvent } from '../support/fake-delivery.ts';
import { ratingAccount } from '../support/rating-account.ts';

const root = resolve(import.meta.dir, '../../..');
const secret = 'fake-provider-callback-secret';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function notificationSocket(port: number, token: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/me/notifications/hint`,
    { headers: { authorization: `Bearer ${token}` } } as unknown as string[]);
  const queued: string[] = [];
  const waiters: ((message: string) => void)[] = [];
  socket.onmessage = event => {
    const message = String(event.data);
    const resolve = waiters.shift();
    if (resolve) resolve(message);
    else queued.push(message);
  };
  const opened = new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error('notification realtime socket failed to open'));
  });
  const next = () => queued.length ? Promise.resolve(queued.shift()!) : new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('notification realtime hint timed out')), 5_000);
    waiters.push(value => { clearTimeout(timer); resolve(value); });
  });
  const close = () => new Promise<void>(resolve => {
    if (socket.readyState === WebSocket.CLOSED) return resolve();
    socket.onclose = () => resolve();
    socket.close();
  });
  return { socket, opened, next, close };
}

async function realtimeHint(connection: ReturnType<typeof notificationSocket>) {
  return JSON.parse(await connection.next()) as { profile: string; generation: string; head: string };
}

async function notificationStack(name: string) {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL) throw new Error('Use the QA integration tier');
  const directory = join(root, '.temp', `notification-${name}-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, ['account', 'access', 'content']);
  const pool = new Pool({ connectionString: databases.urls.access, max: 8 });
  const contentPool = new Pool({ connectionString: databases.urls.content, max: 4 });
  await migrateContent(contentPool);
  const account = await ratingAccount({ ...Bun.env, ACCOUNT_DATABASE_URL: databases.urls.account } as
    Record<string, string>, 'openid notification:manage');
  const content = new ContentCore(contentPool);
  // Subject-owner disclosure decisions, keyed by recipient principal and exact revision.
  const disclosed = new Set<string>();
  const provider = new FakeDeliveryProvider();
  // Cost observation: statements issued by the notification owner.
  const costs = { statements: 0 };
  const measured = {
    query: (...args: unknown[]) => { costs.statements++; return (pool.query as (...a: unknown[]) => unknown)(...args); },
    connect: async () => {
      const client = await pool.connect();
      return { query: (...args: unknown[]) => { costs.statements++;
        return (client.query as (...a: unknown[]) => unknown).apply(client, args); },
      release: () => client.release() };
    },
  } as unknown as Pool;
  const store = new NotificationStore(measured);
  store.setReadAgentReader(async id => ({ id, name: 'Current Agent', handle: `agent-${id.slice(-36)}`,
    avatar: null }));
  const subjects = contentSubjectReader(content, async (principalId, ids) =>
    new Set(ids.filter(id => disclosed.has(`${principalId}:${id}`))));
  store.setDefaultReadSubjectReader(subjects);
  const dispatcher = new NotificationDispatcher(measured, provider, subjects, { retryMs: 0 });
  const access = new AccessAdmissionRegistry(pool);
  const productionDispatcher = new NotificationDispatcher(measured, provider,
    currentContentSubjectReader(content, store, access), { retryMs: 0 });
  const realtime = new NotificationRealtimeHub(pool);
  await realtime.start();
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const deps = { environment: { fuseki, objectDirectory: join(directory, 'objects'),
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH!, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH! } },
  account: account.verifier, access,
  notifications: { store, dispatcher, realtime, providerSecrets: { fake: secret } } };
  const app = createMainApp(fuseki, deps as MainWorkDependencies);
  const call = async (method: string, path: string, token: string | null, body?: object | string,
    headers: Record<string, string> = {}) => {
    const response = await app.handle(new Request(`http://main.local${path}`, { method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body && typeof body === 'object' && 'idempotencyKey' in body
          ? { 'idempotency-key': String(body.idempotencyKey) } : {}),
        ...(body === undefined ? {} : { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' }),
        ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }));
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const principal = (user: { id: string }) => ({ issuer: account.issuer, subject: user.id });
  const principalId = async (user: { id: string }) => (await pool.query<{ id: string }>(
    'SELECT id FROM access.principal WHERE account_issuer = $1 AND account_subject = $2',
    [account.issuer, user.id])).rows[0]!.id;
  const readerActor = `https://rezics.com/id/${randomUUID()}`;
  const allowWorkRead = async (principal: string, subjectRevision: string) => {
    const resource = await content.owningResourceForRevision(subjectRevision);
    if (!resource) throw new Error('Content revision has no owner resource');
    const scope = `work:read:${resource}`;
    await pool.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')
      ON CONFLICT (id) DO NOTHING`, [readerActor]);
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
    const representationId = randomUUID();
    const grantId = randomUUID();
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'work.read', clock_timestamp() + interval '1 hour')`,
    [representationId, principal, readerActor]);
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id,
        action, valid_until) VALUES ($1, $2, $2, $3, 'work.read', clock_timestamp() + interval '1 hour')`,
    [grantId, readerActor, scope]);
    return grantId;
  };
  const revokeWorkRead = async (grantId: string) => {
    await pool.query('UPDATE access.permission_grant SET active = false, generation = generation + 1 WHERE id = $1',
      [grantId]);
  };
  const revision = async (title: string) => {
    const saved = await content.saveDraft({ operationId: `notification-${randomUUID()}`,
      variant: { id: `urn:rezics:variant:${randomUUID()}`, resourceId: `https://rezics.com/id/${randomUUID()}`,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: null, model: 'content-shape-v1', sourceRevision: null,
      provenance: { fixture: 'notification-subject' }, serializedJson: JSON.stringify({ title }) });
    if (saved.outcome !== 'succeeded' || !saved.revisionId) throw new Error('Content owner rejected fixture');
    return saved.revisionId;
  };
  const event = (recipients: string[], subjectRevision: string, overrides: Partial<NotificationEvent> = {}):
    NotificationEvent => ({ sourceOwner: 'content', sourceEvent: `event-${randomUUID()}`, purpose: 'social',
    topic: 'reply', subject: { owner: 'content', ref: `urn:rezics:content:${subjectRevision}`,
      revision: subjectRevision }, disclosureBasis: contentWorkDisclosureBasis(readerActor), recipients, ...overrides });
  const deliveries = async (itemId: string) => (await pool.query<{ id: string; channel: string; state: string;
    cancel_reason: string | null; attempt_count: number }>(`SELECT id, channel, state, cancel_reason, attempt_count
    FROM access.notification_delivery WHERE item_id = $1 ORDER BY channel`, [itemId])).rows;
  const close = async () => {
    await account.close();
    if (app.server) await app.stop();
    await realtime.stop();
    await Promise.all([pool.end(), contentPool.end()]);
    await databases.close();
    rmSync(directory, { recursive: true, force: true });
  };
  return { pool, account, store, dispatcher, productionDispatcher, provider, disclosed, costs, call, principal,
    principalId, revision, readerActor, allowWorkRead, revokeWorkRead, event, deliveries, app, close };
}

test('GOV05: unsubscribe, subject access loss, deactivation and rotation are applied at delivery time', async () => {
  const s = await notificationStack('gov05');
  try {
    const { account } = s;
    // The recipient's own push endpoint; lock-screen disclosure is not authorized.
    const push = await s.call('PUT', '/v1/me/notification-endpoints/push', account.tokenA,
      { profile: 'notification-endpoint-v1', deviceId: 'phone-1', address: 'push-token-1',
        lockScreenDisclosure: false });
    expect(push.status, JSON.stringify(push.body)).toBe(200);
    await s.store.registerEndpoint(s.principal(account.a), { channel: 'email', deviceId: null, address: null,
      addressDigest: digest('a@example.test'), lockScreenDisclosure: false });
    const a = await s.principalId(account.a);
    const r1 = await s.revision('Private reply title');
    s.disclosed.add(`${a}:${r1}`);
    const accessGrant = await s.allowWorkRead(a, r1);

    // Unsubscribe after the intent committed and before delivery.
    const [first] = await s.store.enqueue(s.event([a], r1));
    expect(first!.deliveries).toBe(2);
    const unsubscribe = (state: 'enabled' | 'disabled', expectedRevision: string | null, key: string) =>
      s.call('PUT', '/v1/me/notification-preferences', account.tokenA, { profile: 'notification-preference-v1',
        purpose: 'social', topic: 'reply', channel: 'email', state, expectedRevision, idempotencyKey: key });
    const off = await unsubscribe('disabled', null, 'unsubscribe-1');
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body).toMatchObject({ state: 'disabled', revision: '1', replayed: false });
    expect((await unsubscribe('disabled', null, 'unsubscribe-1')).body.replayed).toBe(true);
    expect((await unsubscribe('enabled', null, 'unsubscribe-1')).status).toBe(409);
    expect((await unsubscribe('enabled', null, 'stale-resubscribe')).body.code).toBe('stale_notification_state');
    const run1 = await s.productionDispatcher.runOnce();
    expect(run1).toMatchObject({ claimed: 1, delivered: 1, cancelled: 1 });
    const firstDeliveries = await s.deliveries(first!.itemId);
    expect(firstDeliveries.map(d => [d.channel, d.state, d.cancel_reason])).toEqual([
      ['email', 'cancelled', 'unsubscribed'], ['push', 'delivered', null]]);
    // Push without lock-screen disclosure carries no private subject field.
    const pushed = s.provider.accepted.get(firstDeliveries[1]!.id)!;
    expect(pushed.payload).toEqual({ notice: 'new-activity' });

    // Re-subscribing does not reactivate the cancelled delivery.
    expect((await unsubscribe('enabled', '1', 'resubscribe-1')).body).toMatchObject({ state: 'enabled', revision: '2' });
    const cancelled = await s.call('GET', `/v1/deliveries/${firstDeliveries[0]!.id}`, account.tokenA);
    expect(cancelled.body).toMatchObject({ state: 'cancelled', cancelReason: 'unsubscribed', attempts: 0 });
    expect((await s.dispatcher.runOnce()).claimed).toBe(0);

    // Losing access to the exact subject before delivery sends nothing.
    const [second] = await s.store.enqueue(s.event([a], r1));
    expect(second!.deliveries).toBe(1); // The saved email choice routes its copy into the digest.
    s.disclosed.delete(`${a}:${r1}`);
    await s.revokeWorkRead(accessGrant);
    const sendsBefore = s.provider.calls.send;
    expect(await s.productionDispatcher.runOnce()).toMatchObject({ claimed: 1, delivered: 0, cancelled: 1 });
    expect((await s.deliveries(second!.itemId)).map(d => d.cancel_reason)).toEqual(['undisclosed']);
    expect(s.provider.calls.send).toBe(sendsBefore);

    // Security messages ignore optional preferences but still respect disclosure and endpoint state.
    s.disclosed.add(`${a}:${r1}`);
    await unsubscribe('disabled', '2', 'unsubscribe-2');
    const bad = await s.call('PUT', '/v1/me/notification-preferences', account.tokenA, {
      profile: 'notification-preference-v1', purpose: 'security', topic: 'login', channel: 'email',
      state: 'disabled', expectedRevision: null, idempotencyKey: 'security-off' });
    expect(bad.status).toBe(400);
    const [security] = await s.store.enqueue(s.event([a], r1, { purpose: 'security', topic: 'reply' }));
    expect(security!.deliveries).toBe(2);
    expect(await s.dispatcher.runOnce()).toMatchObject({ claimed: 2, delivered: 2 });

    // Token rotation cancels the old generation's open delivery; the new endpoint gets no copy.
    const [third] = await s.store.enqueue(s.event([a], r1, { purpose: 'security' }));
    const rotated = await s.call('PUT', '/v1/me/notification-endpoints/push', account.tokenA,
      { profile: 'notification-endpoint-v1', deviceId: 'phone-1', address: 'push-token-2',
        lockScreenDisclosure: true });
    expect(rotated.body).toMatchObject({ generation: '2', retiredDeliveries: 1 });
    await s.dispatcher.runOnce();
    expect((await s.deliveries(third!.itemId)).map(d => [d.channel, d.state, d.cancel_reason])).toEqual([
      ['email', 'delivered', null], ['push', 'cancelled', 'endpoint_invalid']]);

    // A deactivated recipient receives nothing already queued.
    const [fourth] = await s.store.enqueue(s.event([a], r1, { purpose: 'security' }));
    await s.pool.query('UPDATE access.principal SET active = false WHERE id = $1', [a]);
    await s.dispatcher.runOnce();
    expect((await s.deliveries(fourth!.itemId)).map(d => d.cancel_reason)).toEqual(['ineligible', 'ineligible']);
    expect(await s.store.enqueue(s.event([a], r1))).toEqual([]);
    await s.pool.query('UPDATE access.principal SET active = true WHERE id = $1', [a]);

    // Denials: missing scope, another recipient's delivery and an unknown one are indistinguishable.
    expect((await s.call('GET', `/v1/deliveries/${firstDeliveries[1]!.id}`, account.noScope)).status).toBe(401);
    expect((await s.call('GET', `/v1/deliveries/${firstDeliveries[1]!.id}`, null)).status).toBe(401);
    expect((await s.call('GET', `/v1/deliveries/${firstDeliveries[1]!.id}`, account.tokenB)).status).toBe(404);
    expect((await s.call('GET', `/v1/deliveries/${randomUUID()}`, account.tokenA)).status).toBe(404);
  } finally { await s.close(); }
}, 120_000);

test('GOV06: lost acknowledgements reconcile by stable delivery id and repeated callbacks have one effect', async () => {
  const s = await notificationStack('gov06');
  try {
    const { account } = s;
    await s.store.registerEndpoint(s.principal(account.a), { channel: 'email', deviceId: null, address: null,
      addressDigest: digest('a@example.test'), lockScreenDisclosure: false });
    const a = await s.principalId(account.a);
    const r = await s.revision('Delivery subject');
    s.disclosed.add(`${a}:${r}`);
    const only = async () => {
      const [item] = await s.store.enqueue(s.event([a], r, { purpose: 'account', topic: 'notice' }));
      return (await s.deliveries(item!.itemId))[0]!;
    };

    // Accepted, acknowledgement lost: explicit uncertain, then reconciliation without a resend.
    const lost = await only();
    s.provider.next('lose-ack');
    expect(await s.dispatcher.runOnce()).toMatchObject({ claimed: 1, uncertain: 1 });
    expect((await s.call('GET', `/v1/deliveries/${lost.id}`, account.tokenA)).body)
      .toMatchObject({ state: 'uncertain', attempts: 1 });
    const attempt = (await s.pool.query('SELECT outcome FROM access.notification_attempt WHERE delivery_id = $1',
      [lost.id])).rows;
    expect(attempt).toEqual([{ outcome: 'uncertain' }]);
    // Provider unreachable during reconciliation: still uncertain, no blind resend.
    s.provider.lookupDown = true;
    const sends = s.provider.calls.send;
    expect(await s.dispatcher.runOnce()).toMatchObject({ claimed: 1, uncertain: 1 });
    expect(s.provider.calls.send).toBe(sends);
    s.provider.lookupDown = false;
    expect(await s.dispatcher.runOnce()).toMatchObject({ claimed: 1, reconciled: 1 });
    expect(s.provider.calls.send).toBe(sends);
    expect(s.provider.accepted.get(lost.id)!.requests).toBe(1);
    expect((await s.deliveries((await s.pool.query('SELECT item_id FROM access.notification_delivery WHERE id = $1',
      [lost.id])).rows[0].item_id))[0]!.state).toBe('delivered');

    // Failed before acceptance: reconciliation finds nothing and resends under the same id once.
    const early = await only();
    s.provider.next('fail-before-accept');
    await s.dispatcher.runOnce();
    expect(await s.dispatcher.runOnce()).toMatchObject({ delivered: 1 });
    expect(s.provider.accepted.get(early.id)!.requests).toBe(1);
    expect((await s.pool.query(`SELECT attempt, outcome FROM access.notification_attempt WHERE delivery_id = $1
      ORDER BY attempt`, [early.id])).rows).toEqual([{ attempt: 1, outcome: 'uncertain' },
      { attempt: 2, outcome: 'accepted' }]);

    // Worker crash after the provider accepted: the expired lease becomes uncertain and reconciles.
    const crashed = await only();
    const lease = randomUUID();
    await s.pool.query(`UPDATE access.notification_delivery SET state = 'sending', lease_token = $2,
      lease_until = clock_timestamp() - interval '1 second', next_attempt_at = NULL WHERE id = $1`, [crashed.id, lease]);
    await s.provider.send({ deliveryId: crashed.id, channel: 'email', address: null,
      addressDigest: digest('a@example.test'), payload: { revision: r } });
    expect(await s.dispatcher.recoverExpiredLeases()).toBe(1);
    expect(await s.dispatcher.runOnce()).toMatchObject({ reconciled: 1 });
    expect(s.provider.accepted.get(crashed.id)!.requests).toBe(1);

    // Transient rejection retries with a second recorded attempt.
    const transient = await only();
    s.provider.next('transient');
    expect(await s.dispatcher.runOnce()).toMatchObject({ retried: 1 });
    expect(await s.dispatcher.runOnce()).toMatchObject({ delivered: 1 });
    expect((await s.deliveries((await s.pool.query('SELECT item_id FROM access.notification_delivery WHERE id = $1',
      [transient.id])).rows[0].item_id))[0]).toMatchObject({ state: 'delivered', attempt_count: 2 });

    // Concurrent workers lease disjoint rows: every delivery is sent exactly once.
    const batch = await Promise.all(Array.from({ length: 12 }, () => only()));
    const sendsBefore = s.provider.calls.send;
    await Promise.all([s.dispatcher.runOnce(), s.dispatcher.runOnce(), s.dispatcher.runOnce()]);
    expect(s.provider.calls.send - sendsBefore).toBe(12);
    expect(batch.every(d => s.provider.accepted.get(d.id)?.requests === 1)).toBe(true);

    // Signed provider callbacks: repeated delivery has one effect; a reused id with other content conflicts.
    const pending = await only();
    const callback = (raw: string, signature = signProviderEvent(secret, raw)) =>
      s.call('POST', '/v1/notification-providers/fake/events', null, raw, { 'x-rezics-signature': signature });
    const delivered = JSON.stringify({ eventId: 'evt-delivered-1', deliveryId: pending.id, kind: 'delivered' });
    expect((await callback(delivered, 'sha256=00')).status).toBe(401);
    expect((await callback(delivered)).body).toMatchObject({ recorded: true, state: 'delivered' });
    expect((await callback(delivered)).body).toMatchObject({ recorded: false, state: 'delivered' });
    const reused = JSON.stringify({ eventId: 'evt-delivered-1', deliveryId: pending.id, kind: 'failed' });
    expect((await callback(reused)).status).toBe(409);
    // The worker never sends a delivery the provider already confirmed.
    expect((await s.dispatcher.runOnce()).claimed).toBe(0);
    // A late bounce after delivery keeps the delivery and invalidates the address.
    const bounce = JSON.stringify({ eventId: 'evt-bounce-1', deliveryId: pending.id, kind: 'bounced' });
    expect((await callback(bounce)).body).toMatchObject({ recorded: true, state: 'delivered' });
    expect((await callback(bounce)).body.recorded).toBe(false);
    const after = await s.store.enqueue(s.event([a], r, { purpose: 'account', topic: 'notice' }));
    expect(after[0]!.deliveries).toBe(0);
    // Unknown callbacks are retained, not guessed onto a delivery.
    const unknown = JSON.stringify({ eventId: 'evt-unknown-1', deliveryId: null, kind: 'delivered' });
    expect((await callback(unknown)).body).toMatchObject({ recorded: true, state: null });
    expect((await s.call('POST', '/v1/notification-providers/other/events', null, unknown,
      { 'x-rezics-signature': signProviderEvent(secret, unknown) })).status).toBe(404);

    // Cost: one worker run is bounded by its batch, independent of backlog size.
    await s.store.registerEndpoint(s.principal(account.a), { channel: 'email', deviceId: null, address: null,
      addressDigest: digest('a2@example.test'), lockScreenDisclosure: false });
    await Promise.all(Array.from({ length: 40 }, () => only()));
    s.costs.statements = 0;
    const bounded = await s.dispatcher.runOnce(8);
    expect(bounded.claimed).toBe(8);
    expect(s.costs.statements).toBeLessThanOrEqual(8 + 8 * 16);

    // The production scheduler wakes the same bounded dispatcher from durable due rows.
    const scheduled = await only();
    const worker = new NotificationDeliveryWorker(s.dispatcher, 25);
    worker.start();
    try {
      let state = 'pending';
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && state !== 'delivered') {
        await new Promise(resolve => setTimeout(resolve, 20));
        state = (await s.deliveries((await s.pool.query<{ item_id: string }>(
          'SELECT item_id FROM access.notification_delivery WHERE id = $1', [scheduled.id])).rows[0]!.item_id))[0]!.state;
      }
      expect(state).toBe('delivered');
    } finally { await worker.stop(); }
  } finally { await s.close(); }
}, 120_000);

test('GOV06: the configured HTTP provider sends with a stable idempotency key and reconciles lookup', async () => {
  const messages = new Map<string, { messageId: string; requests: number }>();
  const observed: { authorization?: string; idempotencyKey?: string }[] = [];
  const fake = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    observed.push({ authorization: request.headers.get('authorization') ?? undefined,
      idempotencyKey: request.headers.get('idempotency-key') ?? undefined });
    const path = new URL(request.url).pathname;
    if (request.method === 'POST' && path === '/v1/deliveries') {
      const body = await request.json() as { profile: string; deliveryId: string };
      if (body.profile !== 'notification-provider-send-v1'
        || request.headers.get('idempotency-key') !== body.deliveryId) {
        return Response.json({ error: 'invalid request' }, { status: 400 });
      }
      const prior = messages.get(body.deliveryId) ?? { messageId: `msg-${randomUUID()}`, requests: 0 };
      prior.requests++;
      messages.set(body.deliveryId, prior);
      return Response.json({ profile: 'notification-provider-result-v1', status: 'accepted',
        messageId: prior.messageId }, { status: 202 });
    }
    const id = path.match(/^\/v1\/deliveries\/([0-9a-f-]{36})$/)?.[1];
    const prior = id ? messages.get(id) : undefined;
    if (request.method === 'GET' && prior) return Response.json({ profile: 'notification-provider-lookup-v1',
      status: 'delivered', messageId: prior.messageId });
    return new Response(null, { status: 404 });
  } });
  try {
    const provider = new HttpDeliveryProvider({ name: 'http-fake', baseUrl: `http://127.0.0.1:${fake.port}/v1`,
      bearerToken: 'in-stack-secret' });
    const deliveryId = randomUUID();
    const request = { deliveryId, channel: 'push' as const, address: 'push-token',
      addressDigest: digest('push-token'), payload: { notice: 'new-activity' } };
    const accepted = await provider.send(request);
    if (accepted.status !== 'accepted') throw new Error('fake provider did not accept the notification');
    expect(await provider.lookup(deliveryId)).toEqual({ status: 'delivered',
      messageId: accepted.messageId });
    expect(await provider.send({ ...request, channel: 'email', address: null }))
      .toEqual({ status: 'rejected', permanent: true, code: 'address_unavailable' });
    expect(messages.get(deliveryId)?.requests).toBe(1);
    expect(observed).toEqual([
      { authorization: 'Bearer in-stack-secret', idempotencyKey: deliveryId },
      { authorization: 'Bearer in-stack-secret', idempotencyKey: undefined },
    ]);
  } finally { await fake.stop(); }
}, 15_000);

test('GOV08: monotonic read watermarks and a real realtime reconnect reconcile every stream gap', async () => {
  const s = await notificationStack('gov08');
  let connection: ReturnType<typeof notificationSocket> | undefined;
  try {
    const { account } = s;
    await s.call('GET', '/v1/me/notifications/hint', account.tokenA);
    await s.store.registerEndpoint(s.principal(account.a), { channel: 'email', deviceId: null, address: null,
      addressDigest: digest('a@example.test'), lockScreenDisclosure: false });
    const a = await s.principalId(account.a);
    const r = await s.revision('Stream subject');
    s.app.listen({ hostname: '127.0.0.1', port: 0 });
    const port = s.app.server!.port!;
    connection = notificationSocket(port, account.tokenA);
    await connection.opened;
    expect(await realtimeHint(connection)).toMatchObject({ profile: 'notification-stream-hint-v1',
      generation: '1', head: '0' });
    const first = s.event([a], r, { display: { kind: 'reply', actorAgent: s.readerActor, realm: null,
      groupKey: 'chapter-1' } });
    await s.store.enqueue(first);
    expect(await realtimeHint(connection)).toMatchObject({ generation: '1', head: '1' });
    await connection.close();
    const reconnectEvent = s.event([a], r, { display: { kind: 'reply', actorAgent: s.readerActor,
      realm: null, groupKey: 'chapter-1' } });
    await s.store.enqueue(reconnectEvent);
    connection = notificationSocket(port, account.tokenA);
    await connection.opened;
    expect(await realtimeHint(connection)).toMatchObject({ generation: '1', head: '2' });
    await s.store.enqueue(s.event([a], r));
    expect(await realtimeHint(connection)).toMatchObject({ generation: '1', head: '3' });
    // A duplicate source event creates no item and no sequence gap.
    expect((await s.store.enqueue(first))[0]!.replayed).toBe(true);
    const hint = await s.call('GET', '/v1/me/notifications/hint', account.tokenA);
    expect(hint.body).toMatchObject({ generation: '1', head: '3' });
    const page = await s.call('GET', '/v1/me/notifications?after=1:1', account.tokenA);
    expect(page.body.items.map((item: { sequence: string }) => item.sequence)).toEqual(['2', '3']);
    expect(page.body).toMatchObject({ reset: false, head: '3', readThrough: '0', next: null });
    const hidden = (await s.call('GET', '/v1/me/notifications', account.tokenA)).body.items[0];
    expect(hidden).toMatchObject({ subject: null, display: null });
    s.disclosed.add(`${a}:${r}`);
    const shown = (await s.call('GET', '/v1/me/notifications', account.tokenA)).body.items[0];
    expect(shown.display).toMatchObject({ kind: 'reply', actor: { name: 'Current Agent' },
      target: { title: 'Stream subject', language: 'en' } });
    expect((await s.call('GET', '/v1/me/notifications', account.tokenA)).body.groups[0].itemIds)
      .toHaveLength(2);
    expect((await s.call('GET', '/v1/me/notifications/unread-count', account.tokenA)).body)
      .toMatchObject({ count: 3, overflow: false });
    s.disclosed.delete(`${a}:${r}`);
    expect((await s.call('GET', '/v1/me/notifications', account.tokenA)).body.items[0])
      .toMatchObject({ subject: null, display: null });
    expect((await s.call('GET', '/v1/me/notifications/unread-count', account.tokenA)).body)
      .toMatchObject({ count: 0, overflow: false });
    const firstItemId = (await s.pool.query<{ id: string }>(`SELECT id FROM access.notification_item
      WHERE principal_id = $1 AND sequence = 1`, [a])).rows[0]!.id;
    const individuallyRead = await s.call('PUT', `/v1/me/notifications/${firstItemId}/read`, account.tokenA);
    expect(individuallyRead.status).toBe(200);
    expect((await s.call('PUT', `/v1/me/notifications/${firstItemId}/read`, account.tokenA)).body)
      .toEqual(individuallyRead.body);
    expect((await s.call('PUT', `/v1/me/notifications/${firstItemId}/read`, account.tokenB)).status).toBe(404);
    expect((await s.call('GET', '/v1/me/notifications/unread-count', account.tokenA)).body)
      .toMatchObject({ count: 0, overflow: false });

    // Two devices race read positions: the watermark only moves forward and repeats are idempotent.
    const mark = (readThrough: string, generation = '1') => s.call('PUT', '/v1/me/notification-read-watermarks/inbox',
      account.tokenA, { profile: 'notification-read-watermark-v1', generation, readThrough });
    const raced = await Promise.all(['2', '3', '1', '3', '2'].map(value => mark(value)));
    expect(raced.every(response => response.status === 200)).toBe(true);
    expect((await mark('1')).body.readThrough).toBe('3');
    expect((await s.call('GET', '/v1/me/notifications/unread-count', account.tokenA)).body)
      .toMatchObject({ count: 0, overflow: false });
    expect((await mark('4')).body.code).toBe('stale_notification_state');
    expect((await mark('1', '2')).body.code).toBe('stale_notification_state');

    // Concurrent producers interleave with a client that holds an older hint.
    await Promise.all(Array.from({ length: 20 }, () => s.store.enqueue(s.event([a], r))));
    const heldHint = '3';
    const latest = (await s.call('GET', '/v1/me/notifications/hint', account.tokenA)).body;
    expect(latest.head).toBe('23');
    const seen: string[] = [];
    let cursor: string | null = `1:${heldHint}`;
    let pages = 0;
    while (cursor) {
      const next = await s.call('GET', `/v1/me/notifications?after=${cursor}&limit=7`, account.tokenA);
      seen.push(...next.body.items.map((item: { sequence: string }) => item.sequence));
      cursor = next.body.next;
      pages++;
    }
    expect(seen).toEqual(Array.from({ length: 20 }, (_, index) => String(index + 4)));
    expect(pages).toBe(3);

    // Withdrawn and erased items keep their sequence as tombstones without subject fields.
    const erasedItem = (await s.pool.query<{ id: string }>(`SELECT id FROM access.notification_item
      WHERE principal_id = $1 AND sequence = 5`, [a])).rows[0]!.id;
    await s.pool.query(`UPDATE access.notification_item SET state = 'erased', state_changed_at = now()
      WHERE id = $1`, [erasedItem]);
    const tomb = (await s.call('GET', '/v1/me/notifications?after=1:4&limit=1', account.tokenA)).body.items[0];
    expect(tomb).toMatchObject({ sequence: '5', state: 'erased', subject: null });
    expect((await s.call('PUT', `/v1/me/notifications/${erasedItem}/read`, account.tokenA)).status).toBe(404);

    // Other recipients see only their own empty stream.
    expect((await s.call('GET', '/v1/me/notifications', account.tokenB)).body).toMatchObject({ head: '0', items: [] });
    expect((await s.call('GET', '/v1/me/notifications', account.noScope)).status).toBe(401);

    // Explicit reset: new generation, old cursors get reset=true, old watermark stays with its generation.
    const reset = await s.call('POST', '/v1/me/notification-streams/inbox/resets', account.tokenA,
      { profile: 'notification-stream-reset-v1', expectedGeneration: '1' });
    expect(reset.body).toMatchObject({ generation: '2', head: '0' });
    expect((await s.call('POST', '/v1/me/notification-streams/inbox/resets', account.tokenA,
      { profile: 'notification-stream-reset-v1', expectedGeneration: '1' })).status).toBe(409);
    await s.store.enqueue(s.event([a], r));
    const afterReset = (await s.call('GET', '/v1/me/notifications?after=1:23', account.tokenA)).body;
    expect(afterReset).toMatchObject({ generation: '2', reset: true, head: '1', readThrough: '0' });
    expect(afterReset.items.map((item: { sequence: string }) => item.sequence)).toEqual(['1']);
    expect((await mark('1', '2')).body.readThrough).toBe('1');
    expect((await s.pool.query(`SELECT generation::text, read_through::text FROM access.notification_read_watermark
      WHERE principal_id = $1 ORDER BY generation`, [a])).rows).toEqual([
      { generation: '1', read_through: '3' }, { generation: '2', read_through: '1' }]);
    expect((await s.call('GET', '/v1/me/notifications?after=3:0', account.tokenA)).status).toBe(409);

    // Cost: a page read is an index range on the recipient stream; unrelated recipients' growth adds no work.
    const b = await (async () => {
      await s.store.registerEndpoint(s.principal(account.b), { channel: 'email', deviceId: null, address: null,
        addressDigest: digest('b@example.test'), lockScreenDisclosure: false });
      return s.principalId(account.b);
    })();
    let previous = 0;
    for (const total of [100, 1_000, 10_000]) {
      await s.pool.query(`INSERT INTO access.notification_stream (principal_id, stream) VALUES ($1, 'inbox')
        ON CONFLICT DO NOTHING`, [b]);
      await s.pool.query(`UPDATE access.notification_stream SET head_sequence = $2 WHERE principal_id = $1`, [b, total]);
      await s.pool.query(`INSERT INTO access.notification_item (id, principal_id, stream, generation, sequence, purpose,
          topic, source_owner, source_event, subject_owner, subject_ref, disclosure_basis)
        SELECT gen_random_uuid(), $1, 'inbox', 1, n, 'social', 'reply', 'content', 'bulk-' || n, 'content',
          'urn:rezics:bulk', 'content-draft-reader' FROM generate_series($2::bigint, $3::bigint) AS n`,
      [b, previous + 1, total]);
      previous = total;
      await s.pool.query('ANALYZE access.notification_item');
      const plan = (await s.pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF)
        SELECT id, sequence, purpose, topic, state, subject_owner, subject_ref, subject_revision, created_at
        FROM access.notification_item WHERE principal_id = $1 AND stream = 'inbox' AND generation = 2
          AND sequence > 0 ORDER BY sequence LIMIT 51`, [a])).rows[0]['QUERY PLAN'][0].Plan;
      expect(plan['Actual Rows']).toBe(1);
      expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThan(16);
      expect(plan['Temp Read Blocks']).toBe(0);
      s.costs.statements = 0;
      await s.store.readStream(s.principal(account.a), { generation: '2', sequence: '0' });
      expect(s.costs.statements).toBe(9);
    }
  } finally {
    await connection?.close();
    await s.close();
  }
}, 180_000);

test('G-286: unread badge saturates at 99+ only for currently disclosed items', async () => {
  const s = await notificationStack('unread-cap');
  try {
    await s.store.registerEndpoint(s.principal(s.account.a), { channel: 'email', deviceId: null,
      address: null, addressDigest: digest('cap@example.test'), lockScreenDisclosure: false });
    const a = await s.principalId(s.account.a);
    const revision = await s.revision('Cap subject');
    const event = s.event([a], revision);
    await s.pool.query(`INSERT INTO access.notification_stream (principal_id, stream)
      VALUES ($1, 'inbox')`, [a]);
    await s.pool.query(`UPDATE access.notification_stream SET head_sequence = 100
      WHERE principal_id = $1 AND stream = 'inbox'`, [a]);
    await s.pool.query(`INSERT INTO access.notification_item (id, principal_id, stream, generation, sequence,
      purpose, topic, source_owner, source_event, subject_owner, subject_ref, subject_revision, disclosure_basis)
      SELECT gen_random_uuid(), $1, 'inbox', 1, n, 'social', 'reply', 'content', 'cap-' || n,
        'content', $2, $3, $4 FROM generate_series(1, 100) AS n`,
    [a, event.subject.ref, revision, event.disclosureBasis]);
    s.disclosed.add(`${a}:${revision}`);
    expect((await s.call('GET', '/v1/me/notifications/unread-count', s.account.tokenA)).body)
      .toMatchObject({ count: 99, overflow: true });
    const id = (await s.pool.query<{ id: string }>(`SELECT id FROM access.notification_item
      WHERE principal_id = $1 AND sequence = 1`, [a])).rows[0]!.id;
    expect((await s.call('PUT', `/v1/me/notifications/${id}/read`, s.account.tokenA)).status).toBe(200);
    expect((await s.call('GET', '/v1/me/notifications/unread-count', s.account.tokenA)).body)
      .toMatchObject({ count: 99, overflow: false });
    s.disclosed.clear();
    expect((await s.call('GET', '/v1/me/notifications/unread-count', s.account.tokenA)).body)
      .toMatchObject({ count: 0, overflow: false });
    await s.pool.query(`UPDATE access.notification_stream SET head_sequence = 258
      WHERE principal_id = $1 AND stream = 'inbox'`, [a]);
    await s.pool.query(`INSERT INTO access.notification_item (id, principal_id, stream, generation, sequence,
      purpose, topic, source_owner, source_event, subject_owner, subject_ref, subject_revision, disclosure_basis)
      SELECT gen_random_uuid(), $1, 'inbox', 1, n, 'social', 'reply', 'content', 'cap-' || n,
        'content', $2, $3, $4 FROM generate_series(101, 258) AS n`,
    [a, event.subject.ref, revision, event.disclosureBasis]);
    expect((await s.call('GET', '/v1/me/notifications/unread-count', s.account.tokenA)).status).toBe(503);
  } finally { await s.close(); }
}, 180_000);
