import type { FakeRoute } from '../fake-modules';
import recording from '../recorded/settings-preferences.json';
import {
  parsePreferenceChange,
  type PreferenceChange,
  type ReadingPreferences,
  type SettingsPage,
} from '../../settings/preferences';
import { readingAdviceFor, type ReadingIO } from '../../settings/reading-preferences';

export type ReadingScenario = 'default' | 'delayed' | 'lost' | 'conflict' | 'unavailable' | 'closed' | 'denied';

/** Interface-only account preference responses, including historical receipts and an independent current version. */
export function readingFixture(scenario: ReadingScenario = 'default') {
  const initial: ReadingPreferences = {
    spoilerLevel: 0,
    suitability: 'blur',
    version: 0,
    advice: readingAdviceFor({ spoilerLevel: 0, suitability: 'blur' }),
  };
  let current: ReadingPreferences = { ...initial };
  let notifications = { ...recording.notifications };
  const receipts = new Map<string, { input: string; preferences: ReadingPreferences }>();
  const calls: Readonly<PreferenceChange>[] = [];
  let reads = 0;
  let nextRead: { result: SettingsPage; ready: Promise<void> } | undefined;
  let release = () => {};
  const delay = new Promise<void>((resolve) => {
    release = resolve;
  });
  const io: ReadingIO = {
    async save(input) {
      calls.push(input);
      if (scenario === 'closed')
        return { ok: false, reason: 'closed', failure: { status: 403, code: 'platform_closed' } };
      if (scenario === 'denied') return { ok: false, reason: 'forbidden', failure: { status: 403, code: 'forbidden' } };
      const prior = receipts.get(input.idempotencyKey);
      if (prior)
        return prior.input === JSON.stringify(input)
          ? { ok: true, preferences: prior.preferences }
          : { ok: false, reason: 'invalid', failure: { status: 422 } };
      if (scenario === 'conflict' && calls.length === 1) {
        current = {
          spoilerLevel: 2,
          suitability: 'show',
          version: current.version + 1,
          advice: readingAdviceFor({ spoilerLevel: 2, suitability: 'show' }),
        };
        notifications = { ...recording.notifications, reply: false, mention: true };
      }
      if (scenario === 'delayed') await delay;
      if (input.expectedVersion !== current.version)
        return { ok: false, reason: 'conflict', failure: { status: 409, code: 'conflict' } };
      const next: ReadingPreferences = {
        spoilerLevel: input.spoilerLevel ?? current.spoilerLevel,
        suitability: input.suitability ?? current.suitability,
        version: current.version,
      };
      if (next.spoilerLevel !== current.spoilerLevel || next.suitability !== current.suitability) next.version++;
      next.advice = readingAdviceFor(next);
      current = next;
      receipts.set(input.idempotencyKey, { input: JSON.stringify(input), preferences: { ...current } });
      if ((scenario === 'lost' || scenario === 'unavailable') && calls.length === 1)
        return { ok: false, reason: 'unavailable', failure: { status: null } };
      return { ok: true, preferences: { ...current } };
    },
    async read() {
      reads++;
      if (nextRead) {
        const held = nextRead;
        nextRead = undefined;
        await held.ready;
        return held.result;
      }
      if (scenario === 'unavailable')
        return {
          signedIn: true,
          state: 'unavailable',
          failure: { status: 503, code: 'dependency_unavailable' },
          securityHref: null,
        };
      if (scenario === 'closed')
        return {
          signedIn: true,
          state: 'closed',
          failure: { status: 403, code: 'platform_closed' },
          securityHref: null,
        };
      return { signedIn: true, preferences: { ...current }, notifications: { ...notifications }, securityHref: null };
    },
  };
  return {
    initial,
    io,
    calls,
    release,
    reads: () => reads,
    holdNextRead(result: SettingsPage) {
      let finish = () => {};
      nextRead = {
        result,
        ready: new Promise<void>((resolve) => {
          finish = resolve;
        }),
      };
      return finish;
    },
    current: () => ({ ...current, notifications: { ...notifications } }),
    concurrent: (values: Partial<Pick<ReadingPreferences, 'spoilerLevel' | 'suitability'>> = {}) => {
      current = { ...current, ...values, version: current.version + 1 };
      current.advice = readingAdviceFor(current);
      notifications = { ...recording.notifications, reply: false, mention: true };
    },
  };
}

const fixtures = new WeakMap<object, ReturnType<typeof readingFixture>>();
export function readingPageFixture() {
  const context = (globalThis as typeof globalThis & { __rezicsStoryContext?: { url?: string } }).__rezicsStoryContext;
  if (!context) return;
  const scenario = new URL(context.url ?? '/', 'https://rezics.local').searchParams.get('reading-state');
  if (
    scenario !== 'default' &&
    scenario !== 'lost' &&
    scenario !== 'conflict' &&
    scenario !== 'unavailable' &&
    scenario !== 'closed'
  )
    return;
  let fixture = fixtures.get(context);
  if (!fixture) {
    fixture = readingFixture(scenario);
    fixtures.set(context, fixture);
  }
  return fixture;
}

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: /^\/v1\/accounts\/[^/]+\/preferences$/,
    story: async () => {
      const fixture = readingPageFixture();
      if (!fixture) return;
      const result = await fixture.io.read();
      if ('preferences' in result) {
        const { advice, ...values } = result.preferences;
        return {
          status: 200,
          ...values,
          notifications: result.notifications,
          shelf: {},
          ...(advice ?? readingAdviceFor(values)),
        };
      }
      if (result.signedIn && 'failure' in result) {
        const { failure } = result;
        return {
          status: failure.status ?? 503,
          code: failure.code,
          retryable: failure.retryable,
          request_id: failure.requestId,
          ...(failure.retryAfter ? { headers: { 'retry-after': failure.retryAfter } } : {}),
        };
      }
    },
  },
  {
    method: 'PATCH',
    path: /^\/v1\/accounts\/[^/]+\/preferences$/,
    story: async ({ request }) => {
      const fixture = readingPageFixture();
      if (!fixture) return;
      const body: object = await request.json();
      let key: unknown;
      try {
        key = JSON.parse(request.headers.get('idempotency-key') ?? 'null');
      } catch {
        return { status: 400, code: 'invalid_request' };
      }
      const input = parsePreferenceChange({ ...body, idempotencyKey: key });
      if (!input) return;
      const result = await fixture.io.save(input);
      if (!result.ok)
        return { status: result.failure?.status ?? 503, code: result.failure?.code ?? 'dependency_unavailable' };
      const { advice, ...values } = result.preferences;
      return {
        status: 200,
        ...values,
        notifications: fixture.current().notifications,
        shelf: {},
        ...(advice ?? readingAdviceFor(values)),
      };
    },
  },
];
