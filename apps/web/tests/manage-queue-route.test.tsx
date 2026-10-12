import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { header, queuePage, realm } from '../features/manage/fixtures.ts';
import { messages } from '../features/manage/messages.ts';
import { QueueView } from '../features/manage/queue-view.tsx';
import type { Loaded, MainClient, RealmHeader } from '../features/manage/types.ts';

const server = { ...await import('../features/manage/server.ts') };
const reads = { ...await import('../features/manage/read.ts') };
const queueApi = { ...await import('../features/manage/queue-api.ts') };
const i18n = { ...await import('../i18n/server.ts') };
const signInHref = '/auth/sign-in?next=queue';
let result: Loaded<RealmHeader>;
let permissions: string[];
const actingSubject = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const headerRead = mock(async ({ query }: { query: { language: string; actingSubject?: string } }) => {
  if (query.actingSubject !== actingSubject) return { data: null, error: { status: 403, value: {} } };
  return result.ok ? { data: result.data, error: null }
    : { data: null, error: { status: { unavailable: 503, denied: 403, 'sign-in': 401, missing: 404,
      moved: 409, invalid: 400, budget: 422 }[result.failure], value: {} } };
});
const main = { v1: { realms: () => ({ get: headerRead }) } } as unknown as MainClient;
const names = mock(async () => queueApi.noNames);

beforeEach(() => {
  names.mockClear();
  headerRead.mockClear();
  permissions = [];
  mock.module('../features/manage/server.ts', () => ({ ...server,
    managedAddress: async () => ({ id: realm, address: 'books' }),
    manager: async () => ({ actingSubject, main, anonymous: {}, signInHref }),
    permissionsIn: async () => permissions,
  }));
  mock.module('../features/manage/read.ts', () => ({ ...reads,
    readQueue: async () => ({ ok: true, data: queuePage }),
  }));
  mock.module('../features/manage/queue-api.ts', () => ({ ...queueApi, readQueueNames: names }));
  mock.module('../i18n/server.ts', () => ({ ...i18n,
    requestLocale: async () => 'en', getMessages: async () => messages,
  }));
});

afterEach(() => {
  mock.module('../features/manage/server.ts', () => server);
  mock.module('../features/manage/read.ts', () => reads);
  mock.module('../features/manage/queue-api.ts', () => queueApi);
  mock.module('../i18n/server.ts', () => i18n);
});

async function route() {
  const { default: RealmQueueRoute } = await import('../app/[locale]/manage/r/[realm]/page.tsx');
  return RealmQueueRoute({ params: Promise.resolve({ realm: 'books' }),
    searchParams: Promise.resolve({ state: 'closed' }) });
}

for (const failure of ['unavailable', 'denied', 'sign-in'] as const) {
  test(`authorized queue renders without optional header context after its ${failure} response`, async () => {
    result = { ok: false, failure };
    const view = await route();
    expect(view.type).toBe(QueueView);
    expect(view.props).toMatchObject({ initial: queuePage, realmRules: undefined });
    expect(names).toHaveBeenCalledTimes(1);
  });
}

test('unreadable header rules remain absent context without blocking the authorized queue', async () => {
  result = { ok: true, data: { ...header, rules: null } };
  const view = await route();
  expect(view.type).toBe(QueueView);
  expect(view.props).toMatchObject({ initial: queuePage, realmRules: undefined });
  expect(names).toHaveBeenCalledTimes(1);
});

test('known-empty rules still render the moderation queue', async () => {
  result = { ok: true, data: { ...header, rules: [] } };
  const view = await route();
  expect(view.type).toBe(QueueView);
  expect(view.props).toMatchObject({ realmRules: [], initial: queuePage });
  expect(names).toHaveBeenCalledTimes(1);
});

test('a role-only private Realm moderator sees the authorized queue when its header returns 404', async () => {
  permissions = ['governance.moderate'];
  result = { ok: false, failure: 'missing' };
  const view = await route();
  expect(headerRead).toHaveBeenCalledWith({ query: { language: 'en', actingSubject } });
  expect(view.type).toBe(QueueView);
  expect(view.props).toMatchObject({ actingSubject, initial: queuePage, realmRules: undefined,
    authority: { decideReports: true, escalate: true }, rulesHref: null });
  expect(names).toHaveBeenCalledTimes(1);
});
