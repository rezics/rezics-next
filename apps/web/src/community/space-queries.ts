import { queryOptions } from '@tanstack/react-query';
import { personalRead, publicRead, readQueryKey } from '../kernel/query';
import type { ReadCredentialMode } from '../kernel/credential';
import { locateRealmPage, readSpacePage } from './space-actions';

export const spaceQuery = (address: string, locale: string, credentialMode: ReadCredentialMode) =>
  queryOptions({
    ...(credentialMode === 'session' ? personalRead : publicRead),
    queryKey: readQueryKey(['space', address, locale], credentialMode),
    queryFn: () => readSpacePage({ data: { address, credentialMode } }),
  });

export const realmPageQuery = (id: string, locale: string, credentialMode: ReadCredentialMode) =>
  queryOptions({
    ...(credentialMode === 'session' ? personalRead : publicRead),
    queryKey: readQueryKey(['realm-page', id, locale], credentialMode),
    queryFn: () => locateRealmPage({ data: { realmId: id, credentialMode } }),
  });
