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
const { requireSignedIn } = await import('../src/session/guard');

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
      'Session unavailable',
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

test('unavailable and malformed signed-in observations fail closed with the existing unavailable error', async () => {
  const queryClient = client();
  try {
    for (const observation of [
      { state: 'unavailable', subject: null, csrfToken: null },
      { state: 'signed-in', subject: null, csrfToken: 'csrf-without-subject' },
      { state: 'signed-in', subject: 'reader-one', csrfToken: null },
      { state: 'signed-in', subject: 'reader-one', csrfToken: ' ' },
    ]) {
      queryClient.setQueryData(sessionQuery.queryKey, observation);
      await expect(requireSignedIn({ context: { queryClient }, location: location() })).rejects.toThrow(
        'Session unavailable',
      );
    }
  } finally {
    queryClient.clear();
  }
});
