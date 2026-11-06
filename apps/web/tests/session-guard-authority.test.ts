import { expect, mock, test } from 'bun:test';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/session/state', () => ({
  readSessionState: async () => ({ state: 'unavailable', csrfToken: null, subject: null }),
}));

const { QueryClient } = await import('@tanstack/react-query');
const { sessionQuery } = await import('../src/session/query');
const { isSignedInPath, requirePrivatePageAccess, requireSignedIn } = await import('../src/session/guard');

const location = (publicHref = '/fr/settings?from=account#security') => ({ publicHref });
const signedIn = { state: 'signed-in', subject: 'reader-one', csrfToken: 'csrf-one' } as const;

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

test('a successful guard-seeded observation admits the current signed-in page', async () => {
  const queryClient = client();
  try {
    queryClient.setQueryData(sessionQuery.queryKey, signedIn);
    await expect(requireSignedIn({ context: { queryClient }, location: location() })).resolves.toBeUndefined();
  } finally {
    queryClient.clear();
  }
});

test('a successful signed-in observation with explicit null CSRF admits read-only personal routes', async () => {
  const queryClient = client();
  try {
    queryClient.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'reader-one', csrfToken: null });
    await expect(requireSignedIn({ context: { queryClient }, location: location() })).resolves.toBeUndefined();
    expect(queryClient.getQueryState(sessionQuery.queryKey)?.status).toBe('success');
  } finally {
    queryClient.clear();
  }
});

test('ensureQueryData retained errored data cannot authorize a personal loader', async () => {
  const queryClient = client();
  try {
    queryClient.setQueryData(sessionQuery.queryKey, signedIn);
    await queryClient
      .fetchQuery({
        ...sessionQuery,
        queryFn: async () => {
          throw new Error('background session failure');
        },
        staleTime: 0,
      })
      .catch(() => undefined);

    expect(queryClient.getQueryData(sessionQuery.queryKey)).toEqual(signedIn);
    expect(queryClient.getQueryState(sessionQuery.queryKey)?.status).toBe('error');
    await expect(queryClient.ensureQueryData(sessionQuery)).resolves.toEqual(signedIn);
    expect(queryClient.getQueryState(sessionQuery.queryKey)?.status).toBe('error');
    await expect(requireSignedIn({ context: { queryClient }, location: location() })).rejects.toThrow(
      'session_unavailable',
    );
  } finally {
    queryClient.clear();
  }
});

test('a current signed-out observation preserves the localized document redirect and return target', async () => {
  const queryClient = client();
  try {
    queryClient.setQueryData(sessionQuery.queryKey, {
      state: 'signed-out',
      subject: null,
      csrfToken: null,
    });
    await expect(requireSignedIn({ context: { queryClient }, location: location() })).rejects.toMatchObject({
      options: {
        href: `/auth/sign-in?return_to=${encodeURIComponent('/fr/settings?from=account')}`,
        statusCode: 302,
        reloadDocument: true,
      },
    });
  } finally {
    queryClient.clear();
  }
});

test('the four reported private destinations are protected routes', () => {
  for (const path of ['/en/library', '/en/realms', '/en/settings', '/en/creator/sales'])
    expect(isSignedInPath(path)).toBe(true);
});

test('unavailable and malformed observations fail closed with the existing unavailable error', async () => {
  const queryClient = client();
  try {
    const malformedObservations: unknown[] = [
      { state: 'unavailable', subject: null, csrfToken: null },
      { state: 'signed-in', subject: null, csrfToken: 'csrf-without-subject' },
      { state: 'signed-in', subject: 'reader-one', csrfToken: ' ' },
      { state: 'signed-in', csrfToken: null },
      { state: 'signed-in', subject: 12, csrfToken: null },
      { state: 'signed-in', subject: 'reader-one' },
      { state: 'signed-in', subject: 'reader-one', csrfToken: false },
      { state: 'signed-in', subject: 'reader-one', csrfToken: undefined },
      { subject: 'reader-one', csrfToken: null },
      { state: 1, subject: 'reader-one', csrfToken: null },
      null,
      [],
    ];
    for (const observation of malformedObservations) {
      queryClient.setQueryData(sessionQuery.queryKey, observation);
      await expect(requireSignedIn({ context: { queryClient }, location: location() })).rejects.toThrow(
        'session_unavailable',
      );
    }
  } finally {
    queryClient.clear();
  }
});

test('private destination guards throw the native unavailable outcome before a private loader runs', async () => {
  const queryClient = client();
  try {
    queryClient.setQueryData(sessionQuery.queryKey, { state: 'unavailable', subject: null, csrfToken: null });
    await expect(requirePrivatePageAccess({ context: { queryClient }, location: location() })).rejects.toMatchObject({
      status: 503,
      code: 'session_unavailable',
    });
  } finally {
    queryClient.clear();
  }
});
