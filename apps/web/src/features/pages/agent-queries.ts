import { queryOptions } from '@tanstack/react-query';
import type { AccountView } from '../../accounts/public-profile/page-read';
import { personalRead, publicRead } from '../../kernel/query';
import { defaultReader } from '../../subject/reader';
import type { AgentReaderResult } from './agent-actions';
import type { ReaderFailure } from './agent-reader';
import { readAgentPage, readAgentReader } from './agent-actions';

export type AgentReaderQueryKey = readonly [
  'agent-reader',
  string,
  string,
  string,
  string | null,
  number,
  number,
  number,
];

/** One private observer owns one mounted route and one observed credential admission. */
export type AgentReaderQueryScope = {
  reader: string | null;
  route: string;
  revision: number;
  mount: number;
  generation: number;
  enabled: boolean;
  queryKey: AgentReaderQueryKey;
  current: () => boolean;
  retire: (reason?: ReaderFailure) => void;
  accept: (result: AgentReaderResult) => void;
  accepts: (result: AgentReaderResult | undefined) => boolean;
};

/** The public profile and overview document, shared by the server loader and hydrated page. */
export const agentPageQuery = (handle: string, locale: string, search?: string) =>
  queryOptions({
    ...publicRead,
    queryKey: ['agent-page', handle, locale, search ?? ''],
    queryFn: () => readAgentPage({ data: { handle, locale, search } }),
  });

/** One public named view and its overview, with an optional bounded continuation. */
export const agentViewQuery = (handle: string, locale: string, view: AccountView, cursor?: string, search?: string) =>
  queryOptions({
    ...publicRead,
    queryKey: ['agent-view', handle, locale, view, cursor ?? null, search ?? ''],
    queryFn: () => readAgentPage({ data: { handle, locale, view, cursor, search } }),
  });

/** Reader preferences are personal state: each admitted mounted route owns its exact private cache entry. */
export const agentReaderQuery = (handle: string, locale: string, scope: AgentReaderQueryScope) =>
  queryOptions({
    ...personalRead,
    queryKey: scope.queryKey,
    enabled: typeof window !== 'undefined' && personalRead.enabled && scope.enabled && scope.current(),
    queryFn: async () => {
      const expectedReader = scope.reader;
      const unavailable = { kind: 'default' as const, reason: 'retired' as const, accountId: null, reader: defaultReader };
      if (!expectedReader || !scope.current()) return unavailable;
      try {
        const result = await readAgentReader({ data: { handle, locale, expectedReader } });
        if (!scope.current()) return unavailable;
        if (result.kind !== 'ready' || result.accountId !== expectedReader) {
          scope.retire(result.kind === 'default' ? result.reason : 'rejected');
          return result.kind === 'default' ? result : { kind: 'default' as const, reason: 'rejected' as const, accountId: result.accountId, reader: defaultReader };
        }
        scope.accept(result);
        return result;
      } catch (error) {
        if (!scope.current()) return unavailable;
        throw error;
      }
    },
    staleTime: Infinity,
    refetchOnMount: false,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
