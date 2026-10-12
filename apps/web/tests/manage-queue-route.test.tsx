import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { header, queuePage, realm } from '../features/manage/fixtures.ts';
import { messages } from '../features/manage/messages.ts';
import { ManageFailure } from '../features/manage/parts.tsx';
import { QueueView } from '../features/manage/queue-view.tsx';
import type { Loaded, RealmHeader } from '../features/manage/types.ts';

const server = { ...await import('../features/manage/server.ts') };
const reads = { ...await import('../features/manage/read.ts') };
const queueApi = { ...await import('../features/manage/queue-api.ts') };
const i18n = { ...await import('../i18n/server.ts') };
const signInHref = '/auth/sign-in?next=queue';
const retryHref = '/en/manage/r/books?state=closed';
let result: Loaded<RealmHeader>;
const names = mock(async () => queueApi.noNames);

beforeEach(() => {
  names.mockClear();
  mock.module('../features/manage/server.ts', () => ({ ...server,
    managedAddress: async () => ({ id: realm, address: 'books' }),
    manager: async () => ({ actingSubject: realm, main: {}, anonymous: {}, signInHref }),
    permissionsIn: async () => [], realmHeader: async () => result,
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
  test(`queue preserves a failed header's ${failure} response instead of treating its rules as empty`, async () => {
    result = { ok: false, failure };
    const view = await route();
    expect(view.type).toBe(ManageFailure);
    expect(view.props).toMatchObject({ failure, retryHref, signInHref });
    expect(names).not.toHaveBeenCalled();
  });
}

test('unreadable rules show the existing unavailable view with a retry, without moderation controls', async () => {
  result = { ok: true, data: { ...header, rules: null } };
  const view = await route();
  expect(view.type).toBe(ManageFailure);
  expect(view.props).toMatchObject({ failure: 'unavailable', retryHref });
  const html = renderToStaticMarkup(view);
  expect(html).toContain('Couldn’t load this');
  expect(html).toContain(`href="${retryHref}"`);
  expect(html).toContain('Try again');
  expect(names).not.toHaveBeenCalled();
});

test('known-empty rules still render the moderation queue', async () => {
  result = { ok: true, data: { ...header, rules: [] } };
  const view = await route();
  expect(view.type).toBe(QueueView);
  expect(view.props).toMatchObject({ realmRules: [], initial: queuePage });
  expect(names).toHaveBeenCalledTimes(1);
});
