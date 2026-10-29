import { queryOptions } from '@tanstack/react-query';
import type { View } from '@rezics/composition';
import { personalRead, publicRead } from '../../kernel/query';
import { readAgentPage, readAgentReader } from './agent-actions';

/** The public profile and overview document, shared by the server loader and hydrated page. */
export const agentPageQuery = (handle: string, locale: string, search?: string) =>
  queryOptions({
    ...publicRead,
    queryKey: ['agent-page', handle, locale, search ?? ''],
    queryFn: () => readAgentPage({ data: { handle, locale, search } }),
  });

/** One public named view and its overview, with an optional bounded continuation. */
export const agentViewQuery = (handle: string, locale: string, view: View, cursor?: string, search?: string) =>
  queryOptions({
    ...publicRead,
    queryKey: ['agent-view', handle, locale, view, cursor ?? null, search ?? ''],
    queryFn: () => readAgentPage({ data: { handle, locale, view, cursor, search } }),
  });

/** Reader preferences are personal state: this factory cannot run during server rendering. */
export const agentReaderQuery = (handle: string, locale: string) =>
  queryOptions({
    ...personalRead,
    queryKey: ['agent-reader', handle, locale],
    queryFn: () => readAgentReader({ data: { handle, locale } }),
    retry: false,
  });
