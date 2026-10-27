import { queryOptions } from '@tanstack/react-query';
import { publicRead } from '../kernel/query';
import { locateRealmPage, readSpacePage } from './space-actions';

export const spaceQuery = (address: string, locale: string) =>
  queryOptions({
    ...publicRead,
    queryKey: ['space', address, locale],
    queryFn: () => readSpacePage({ data: { address } }),
  });

export const realmPageQuery = (id: string, locale: string) =>
  queryOptions({
    ...publicRead,
    queryKey: ['realm-page', id, locale],
    queryFn: () => locateRealmPage({ data: { realmId: id } }),
  });
