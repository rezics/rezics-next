import { queryOptions } from '@tanstack/react-query';
import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { publicRead } from '../kernel/query';
import { cookie, SESSION_COOKIE } from '../session/cookies';
import { readBoardPage, readThreadPage, readThreadSlug } from './reads';

/** Whether this navigation carries a session cookie. Anonymous reads share one cache entry. */
export type CredentialMode = 'anonymous' | 'credential';

export const credentialMode = createIsomorphicFn()
  .server((): CredentialMode => (cookie(getRequest(), SESSION_COOKIE) ? 'credential' : 'anonymous'))
  .client((): CredentialMode => 'anonymous');

export function threadSlugQuery(id: string, credentialMode: CredentialMode) {
  return queryOptions({
    ...publicRead,
    queryKey: ['thread-slug', id, credentialMode],
    queryFn: () => readThreadSlug({ data: { id } }),
  });
}

export function threadPageQuery(
  id: string,
  cursor: string | undefined,
  credentialMode: CredentialMode,
  expectedSlug?: string,
) {
  return queryOptions({
    ...publicRead,
    queryKey: ['thread-page', id, cursor ?? null, credentialMode, expectedSlug ?? null],
    queryFn: () =>
      readThreadPage({
        data: {
          id,
          ...(cursor === undefined ? {} : { cursor }),
          ...(expectedSlug === undefined ? {} : { expectedSlug }),
        },
      }),
  });
}

export function boardPageQuery(
  id: string,
  cursor: string | undefined,
  sort: 'hot' | 'new' | undefined,
  credentialMode: CredentialMode,
) {
  return queryOptions({
    ...publicRead,
    queryKey: ['board-page', id, cursor ?? null, sort ?? null, credentialMode],
    queryFn: () =>
      readBoardPage({
        data: {
          id,
          ...(cursor === undefined ? {} : { cursor }),
          ...(sort === undefined ? {} : { sort }),
        },
      }),
  });
}
