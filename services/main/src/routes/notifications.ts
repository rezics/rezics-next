import { createHmac, timingSafeEqual } from 'node:crypto';
import { Elysia, t } from 'elysia';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import type { NotificationDispatcher } from '../modules/notification/dispatcher.ts';
import { NotificationConflict, NotificationDenied, NotificationInvalid, NotificationStale,
  NotificationUnavailable, sha256, type NotificationStore } from '../modules/notification/store.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

/**
 * Bearer scope for the recipient's own notification state. Account has no
 * dedicated notification scope yet; replace this constant when it does.
 */
export const NOTIFICATION_SCOPE = 'work:read';

export interface NotificationRouteDependencies {
  notifications?: {
    store: NotificationStore;
    dispatcher?: NotificationDispatcher;
    /** Provider name -> shared callback signing secret. */
    providerSecrets?: Readonly<Record<string, string>>;
  };
}

const uuid = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const counter = t.String({ pattern: '^(0|[1-9][0-9]{0,18})$' });
const generation = t.String({ pattern: '^[1-9][0-9]{0,18}$' });
const noStore = { headers: { 'cache-control': 'no-store' } };

const streamItem = t.Object({ id: t.String(), sequence: t.String(), purpose: t.String(), topic: t.String(),
  state: t.Union([t.Literal('active'), t.Literal('withdrawn'), t.Literal('erased')]),
  subject: t.Nullable(t.Object({ owner: t.String(), ref: t.String(), revision: t.Nullable(t.String()) })),
  createdAt: t.String() });
const streamPage = t.Object({ profile: t.Literal('notification-stream-page-v1'), generation: t.String(),
  head: t.String(), reset: t.Boolean(), readThrough: t.String(), items: t.Array(streamItem),
  next: t.Nullable(t.String()) });
const hint = t.Object({ profile: t.Literal('notification-stream-hint-v1'), generation: t.String(), head: t.String() });
const watermark = t.Object({ profile: t.Literal('notification-read-watermark-v1'), generation: t.String(),
  readThrough: t.String() });
const preference = t.Object({ profile: t.Literal('notification-preference-v1'), purpose: t.String(),
  topic: t.String(), channel: t.String(), state: t.String(), revision: t.String(), replayed: t.Boolean() });
const endpoint = t.Object({ profile: t.Literal('notification-endpoint-v1'), id: t.String(),
  generation: t.String(), retiredDeliveries: t.Number() });
const delivery = t.Object({ profile: t.Literal('notification-delivery-v1'), id: t.String(), itemId: t.String(),
  channel: t.String(), state: t.String(), cancelReason: t.Nullable(t.String()), attempts: t.Number(),
  terminalAt: t.Nullable(t.String()) });
const providerEventResult = t.Object({ profile: t.Literal('notification-provider-event-v1'),
  recorded: t.Boolean(), state: t.Nullable(t.String()) });

export function notificationError(error: unknown): Response {
  if (error instanceof NotificationInvalid) return problem(400, 'invalid_notification_request', error.message);
  if (error instanceof NotificationDenied) return problem(404, 'not_found', 'Notification state is unavailable');
  if (error instanceof NotificationConflict) return problem(409, 'idempotency_conflict', error.message);
  if (error instanceof NotificationStale) return problem(409, 'stale_notification_state', error.message);
  if (error instanceof NotificationUnavailable) return problem(503, 'notification_unavailable', error.message);
  return commandError(error);
}

function signatureMatches(secret: string, raw: string, header: string | null): boolean {
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`);
  const actual = Buffer.from(header ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** GOV05-GOV08 recipient notification state and provider callbacks (template: modules/notification/README.md). */
export function notificationRoutes(work: MainWorkDependencies) {
  const owner = (work as MainWorkDependencies & NotificationRouteDependencies).notifications;
  const unavailable = () => problem(503, 'notification_unavailable', 'Notifications are unavailable');
  return new Elysia()
    .get('/v1/me/notifications', {
      query: t.Object({ after: t.Optional(t.String({ pattern: '^[1-9][0-9]{0,18}:(0|[1-9][0-9]{0,18})$' })),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 50 })) }, { additionalProperties: false }),
      response: { 200: streamPage, ...authorizedReadProblems },
    }, async ({ request, query }) => {
      try {
        const principal = await work.account.verify(request, [NOTIFICATION_SCOPE]);
        if (!owner) return unavailable();
        const [generationPart, sequencePart] = query.after?.split(':') ?? [];
        const page = await owner.store.readStream(principal,
          generationPart && sequencePart ? { generation: generationPart, sequence: sequencePart } : null,
          query.limit ?? 50);
        return Response.json({ profile: 'notification-stream-page-v1', ...page }, noStore);
      } catch (error) { return notificationError(error); }
    })
    .get('/v1/me/notifications/hint', {
      response: { 200: hint, ...authorizedReadProblems },
    }, async ({ request }) => {
      try {
        const principal = await work.account.verify(request, [NOTIFICATION_SCOPE]);
        if (!owner) return unavailable();
        return Response.json({ profile: 'notification-stream-hint-v1', ...await owner.store.hint(principal) },
          noStore);
      } catch (error) { return notificationError(error); }
    })
    .put('/v1/me/notification-read-watermarks/inbox', {
      body: t.Object({ profile: t.Literal('notification-read-watermark-v1'), generation, readThrough: counter },
        { additionalProperties: false }),
      response: { 200: watermark, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, [NOTIFICATION_SCOPE]);
        if (!owner) return unavailable();
        const result = await owner.store.advanceWatermark(principal, body.generation, body.readThrough);
        return Response.json({ profile: 'notification-read-watermark-v1', generation: result.generation,
          readThrough: result.readThrough }, noStore);
      } catch (error) { return notificationError(error); }
    })
    .post('/v1/me/notification-streams/inbox/resets', {
      body: t.Object({ profile: t.Literal('notification-stream-reset-v1'), expectedGeneration: generation },
        { additionalProperties: false }),
      response: { 200: hint, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, [NOTIFICATION_SCOPE]);
        if (!owner) return unavailable();
        const result = await owner.store.resetStream(principal, body.expectedGeneration);
        return Response.json({ profile: 'notification-stream-hint-v1', generation: result.generation, head: '0' },
          noStore);
      } catch (error) { return notificationError(error); }
    })
    .put('/v1/me/notification-preferences', {
      body: t.Object({ profile: t.Literal('notification-preference-v1'),
        purpose: t.Union([t.Literal('social'), t.Literal('subscription'), t.Literal('governance')]),
        topic: t.String({ pattern: '^[a-z][a-z0-9_.-]{0,63}$' }),
        channel: t.Union([t.Literal('inbox'), t.Literal('email'), t.Literal('push')]),
        state: t.Union([t.Literal('enabled'), t.Literal('disabled')]),
        expectedRevision: t.Nullable(t.String({ pattern: '^[1-9][0-9]{0,18}$' })),
        idempotencyKey: t.String({ pattern: '^[A-Za-z0-9:_./-]{1,128}$' }) }, { additionalProperties: false }),
      response: { 200: preference, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, [NOTIFICATION_SCOPE]);
        if (!owner) return unavailable();
        const result = await owner.store.setPreference(principal, { ...body, via: 'settings' });
        return Response.json({ profile: 'notification-preference-v1', ...result }, noStore);
      } catch (error) { return notificationError(error); }
    })
    .put('/v1/me/notification-endpoints/push', {
      body: t.Object({ profile: t.Literal('notification-endpoint-v1'),
        deviceId: t.String({ pattern: '^[A-Za-z0-9:_./-]{1,128}$' }),
        address: t.String({ minLength: 1, maxLength: 2048 }), lockScreenDisclosure: t.Boolean() },
      { additionalProperties: false }),
      response: { 200: endpoint, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, [NOTIFICATION_SCOPE]);
        if (!owner) return unavailable();
        const result = await owner.store.registerEndpoint(principal, { channel: 'push', deviceId: body.deviceId,
          address: body.address, addressDigest: sha256(body.address),
          lockScreenDisclosure: body.lockScreenDisclosure });
        return Response.json({ profile: 'notification-endpoint-v1', id: result.id, generation: result.generation,
          retiredDeliveries: result.retired }, noStore);
      } catch (error) { return notificationError(error); }
    })
    .get('/v1/deliveries/:delivery', {
      params: t.Object({ delivery: t.String({ pattern: uuid }) }),
      response: { 200: delivery, ...authorizedReadProblems },
    }, async ({ request, params }) => {
      try {
        const principal = await work.account.verify(request, [NOTIFICATION_SCOPE]);
        if (!owner) return unavailable();
        const result = await owner.store.readDelivery(principal, params.delivery);
        return Response.json({ profile: 'notification-delivery-v1', ...result }, noStore);
      } catch (error) { return notificationError(error); }
    })
    .post('/v1/notification-providers/:provider/events', {
      params: t.Object({ provider: t.String({ pattern: '^[a-z][a-z0-9_.-]{0,63}$' }) }),
      parse: 'text',
      body: t.String({ maxLength: 16_384 }),
      response: { 200: providerEventResult, ...writeProblems },
    }, async ({ request, params, body }) => {
      try {
        const secret = owner?.providerSecrets?.[params.provider];
        if (!owner?.dispatcher || !secret || owner.dispatcher.providerName !== params.provider) {
          return problem(404, 'not_found', 'No such notification provider');
        }
        if (!signatureMatches(secret, body, request.headers.get('x-rezics-signature'))) {
          return problem(401, 'unauthenticated', 'Provider signature is invalid');
        }
        let event: { eventId?: unknown; deliveryId?: unknown; kind?: unknown };
        try { event = JSON.parse(body); } catch { throw new NotificationInvalid('provider event is not JSON'); }
        if (typeof event.eventId !== 'string' || (event.deliveryId !== null && typeof event.deliveryId !== 'string')
          || !['delivered', 'bounced', 'complained', 'failed', 'suppressed'].includes(event.kind as string)) {
          throw new NotificationInvalid('provider event does not match its profile');
        }
        const result = await owner.dispatcher.recordProviderEvent({ eventId: event.eventId,
          deliveryId: event.deliveryId as string | null,
          kind: event.kind as 'delivered' | 'bounced' | 'complained' | 'failed' | 'suppressed',
          payloadDigest: sha256(body) });
        return Response.json({ profile: 'notification-provider-event-v1', ...result }, noStore);
      } catch (error) { return notificationError(error); }
    });
}
