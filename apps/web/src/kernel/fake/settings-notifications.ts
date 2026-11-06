import type { FakeRoute } from '../fake-modules.ts';
import recording from '../recorded/settings-preferences.json';
import { parseNotificationChange, type NotificationPreferences, type PreferencePage } from '../../settings/preferences';

const optionalDefaults = {
  reply: true,
  mention: true,
  thread_watch: true,
  board_activity: true,
} as const satisfies Record<Exclude<PreferencePage['kinds'][number]['kind'], 'moderation_decision'>, true>;

/** Recorded Settings page matching the native catalogue projection. */
export function settingsPreferencePage(notifications: NotificationPreferences, version: number): PreferencePage {
  return {
    version,
    kinds: [
      ...(Object.keys(optionalDefaults) as (keyof typeof optionalDefaults)[]).map((kind) => ({
        kind,
        optional: true,
        default: optionalDefaults[kind],
        enabled: notifications[kind] ?? optionalDefaults[kind],
      })),
      { kind: 'moderation_decision' as const, optional: false, default: true, enabled: true },
    ],
    actions: [
      { name: 'edit', expectedVersion: version },
      { name: 'reset', expectedVersion: version },
    ],
  };
}

/** Native-shaped fetch responses for the default Settings journey; the real actions and editors stay connected. */
export function notificationRecoveryTransport(fallback: typeof fetch) {
  let current = { ...recording, notifications: { ...recording.notifications } as NotificationPreferences };
  let receipt: { key: string; body: string; settings: typeof current } | null = null;
  let nextFailure: { status: number; code: string; retryAfter?: string } | null = null;
  let readGate: Promise<void> | null = null;
  let releaseRead = () => {};
  const reads: { path: string; authorization: string | null; key: string | null }[] = [];
  const commands: {
    path: string;
    method: string;
    key: string | null;
    body: string;
    authorization: string | null;
    contentType: string | null;
  }[] = [];
  const fetcher = (async (input, init) => {
    const request = new Request(input instanceof Request ? input : new URL(String(input), window.location.href), init);
    const url = new URL(request.url);
    if (url.origin !== 'http://kernel.local' || !/^\/v1\/accounts\/[^/]+\/preferences$/.test(url.pathname))
      return fallback(input, init);
    if (request.method === 'GET') {
      reads.push({
        path: url.pathname,
        authorization: request.headers.get('authorization'),
        key: request.headers.get('idempotency-key'),
      });
      const failure = nextFailure;
      nextFailure = null;
      const gate = readGate;
      readGate = null;
      if (gate) await gate;
      return failure
        ? Response.json(
            { code: failure.code, detail: 'Private notification read diagnostic', request_id: 'notification-read' },
            { status: failure.status, headers: failure.retryAfter ? { 'retry-after': failure.retryAfter } : {} },
          )
        : Response.json({ ...current, page: settingsPreferencePage(current.notifications, current.version) });
    }
    const body = await request.text();
    const key = request.headers.get('idempotency-key');
    commands.push({
      path: url.pathname,
      method: request.method,
      key,
      body,
      authorization: request.headers.get('authorization'),
      contentType: request.headers.get('content-type'),
    });
    if (request.method !== 'PATCH' || !key) return new Response(null, { status: 405 });
    if (receipt?.key === key)
      return receipt.body === body
        ? Response.json({
            ...receipt.settings,
            page: settingsPreferencePage(receipt.settings.notifications, receipt.settings.version),
          })
        : Response.json({ code: 'invalid_request' }, { status: 422 });
    const change = parseNotificationChange({ ...JSON.parse(body), idempotencyKey: JSON.parse(key) });
    if (!change) return Response.json({ code: 'invalid_request' }, { status: 422 });
    if (change.expectedVersion !== current.version)
      return Response.json(
        { code: 'conflict', page: settingsPreferencePage(current.notifications, current.version) },
        { status: 409 },
      );
    const notifications: NotificationPreferences =
      change.notifications === null ? { ...recording.notifications } : { ...current.notifications };
    for (const [kind, enabled] of Object.entries(change.notifications ?? {})) notifications[kind] = enabled ?? true;
    current = { ...current, notifications, version: current.version + 1 };
    const original = receipt === null;
    receipt = { key, body, settings: current };
    return original
      ? Response.json({ code: 'dependency_unavailable' }, { status: 503 })
      : Response.json({ ...current, page: settingsPreferencePage(current.notifications, current.version) });
  }) as typeof fetch;
  return {
    fetcher,
    reads,
    commands,
    failNextRead: (status: number, code: string, retryAfter?: string) => {
      nextFailure = { status, code, ...(retryAfter ? { retryAfter } : {}) };
    },
    pauseNextRead: () => {
      readGate = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
    },
    releaseRead: () => releaseRead(),
    concurrent: (notifications: NotificationPreferences) => {
      current = { ...current, notifications: { ...notifications }, version: current.version + 1 };
    },
  };
}

function notificationState(): string | null {
  const context = (globalThis as typeof globalThis & { __rezicsStoryContext?: { url?: string } }).__rezicsStoryContext;
  return new URL(context?.url ?? '/settings', 'http://rezics.local').searchParams.get('notification-state');
}

const failures = {
  generic: {
    status: 503,
  },
  deadline: {
    status: 503,
    type: 'https://rezics.com/problems/deadline_exceeded',
    code: 'deadline_exceeded',
    retryable: true,
    request_id: 'story-settings-deadline',
    headers: { 'retry-after': '30' },
  },
  dependency: {
    status: 503,
    type: 'https://rezics.com/problems/dependency_unavailable',
    code: 'dependency_unavailable',
    retryable: true,
    request_id: 'story-settings-preparing',
  },
  closed: {
    status: 403,
    type: 'https://rezics.com/problems/platform_closed',
    code: 'platform_closed',
    retryable: false,
    request_id: 'story-settings-closed',
  },
  unavailable: {
    status: 500,
    type: 'https://rezics.com/problems/internal_error',
    code: 'internal_error',
    retryable: true,
    request_id: 'story-settings-unavailable',
  },
} as const;

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: /^\/v1\/accounts\/[^/]+\/preferences$/,
    story: () => {
      const state = notificationState();
      return state === 'generic' ||
        state === 'deadline' ||
        state === 'dependency' ||
        state === 'closed' ||
        state === 'unavailable'
        ? failures[state]
        : undefined;
    },
  },
];
