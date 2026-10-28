import { queryOptions } from '@tanstack/react-query';
import { personalRead, publicRead, readQueryKey } from '../kernel/query';
import type { ReadCredentialMode } from '../kernel/credential';
import { readBoardPage, readThreadPage, readThreadSlug } from './reads';
import { readThreadPersonal } from './reads';

export type CredentialMode = ReadCredentialMode;

export function threadSlugQuery(id: string, credentialMode: CredentialMode) {
  return queryOptions({
    ...publicRead,
    queryKey: readQueryKey(['thread-slug', id], credentialMode),
    queryFn: () => readThreadSlug({ data: { id, credentialMode } }),
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
    queryKey: readQueryKey(['thread-page', id, cursor ?? null, expectedSlug ?? null], credentialMode),
    queryFn: () =>
      readThreadPage({
        data: {
          id,
          ...(cursor === undefined ? {} : { cursor }),
          ...(expectedSlug === undefined ? {} : { expectedSlug }),
          credentialMode,
        },
      }),
  });
}

export function threadPersonalQuery(id: string, cursor: string | undefined, postIds: string[]) {
  return queryOptions({
    ...personalRead,
    queryKey: ['thread-personal', id, cursor ?? null, ...postIds],
    queryFn: async () => ({
      ...(await readThreadPersonal({ data: { id, postIds } })),
      idempotencyKey: crypto.randomUUID(),
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
    queryKey: readQueryKey(['board-page', id, cursor ?? null, sort ?? null], credentialMode),
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
