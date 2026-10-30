import { useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { personalRead } from '../../kernel/query';
import { useSession } from '../../session/query';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { relationTargetSearch } from '../catalogue/relation-editor-search';
import { changeContextWorkspace, readContextCreation, readContextDirectory, readContextWorkspace } from './actions';
import { contextQueryKey, unavailable, type Command, type DirectoryInput, type MutationResult } from './model';
import { ContextCreateView, ContextDetailView, ContextDirectoryView, ContextFeedback } from './view';

type Mode = { mode: 'directory'; input: DirectoryInput } | { mode: 'create' } | { mode: 'detail'; id: string };
const prefix = ['context-workspace'] as const;
function clearPrivate(client: QueryClient, actor?: string, keep?: readonly unknown[]) {
  client.removeQueries({
    predicate: (query) =>
      query.queryKey[0] === prefix[0] &&
      (!actor || query.queryKey[1] === actor) &&
      (!keep || JSON.stringify(query.queryKey) !== JSON.stringify(keep)),
  });
}
function useVisit(key: readonly unknown[]) {
  const scope = JSON.stringify(key);
  const client = useQueryClient();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // Retire only this visit; a newly mounted query for this actor owns its own lifetime.
      void client.cancelQueries({ queryKey: key, exact: true });
      client.removeQueries({ queryKey: key, exact: true });
    };
  }, [scope, client]);
  return { client, alive };
}
function DirectorySession({ actor, locale, input }: { actor: string; locale: string; input: DirectoryInput }) {
  const key = contextQueryKey(actor, locale, 'directory', input);
  const { client } = useVisit(key);
  const query = useQuery({
    ...personalRead,
    queryKey: key,
    queryFn: () => readContextDirectory({ data: input }),
    gcTime: 0,
    retry: false,
  });
  const data = query.data;
  useEffect(() => {
    if (data && [data.page.kind, data.creation.kind].some((kind) => kind === 'denied' || kind === 'signed-out'))
      clearPrivate(client, actor, key);
  }, [data, actor, client]);
  return (
    <ContextDirectoryView
      locale={locale}
      input={input}
      data={query.isFetching ? null : query.isError ? { page: unavailable, creation: unavailable } : (data ?? null)}
      reload={() => query.refetch()}
    />
  );
}
function CreateSession({ actor, locale, csrfToken }: { actor: string; locale: string; csrfToken: string }) {
  const key = contextQueryKey(actor, locale, 'create', null);
  const { client, alive } = useVisit(key);
  const query = useQuery({
    ...personalRead,
    queryKey: key,
    queryFn: () => readContextCreation(),
    gcTime: 0,
    retry: false,
  });
  async function submit(command: Command): Promise<MutationResult> {
    await client.cancelQueries({ queryKey: key, exact: true });
    if (!alive.current) return unavailable;
    clearPrivate(client, actor, key);
    const result = await changeContextWorkspace({ data: command, headers: { 'X-CSRF-Token': csrfToken } });
    if (!alive.current) return result;
    await query.refetch();
    return result;
  }
  return (
    <ContextCreateView
      locale={locale}
      actions={query.isFetching ? null : query.isError ? unavailable : (query.data ?? null)}
      submit={submit}
      reload={() => query.refetch()}
    />
  );
}
function DetailSession({
  actor,
  locale,
  id,
  csrfToken,
}: {
  actor: string;
  locale: string;
  id: string;
  csrfToken: string;
}) {
  const key = contextQueryKey(actor, locale, 'detail', id);
  const { client, alive } = useVisit(key);
  const session = useRef<string | undefined>(undefined);
  const query = useQuery({
    ...personalRead,
    queryKey: key,
    queryFn: async () => {
      const result = await readContextWorkspace({
        data: { id, ...(session.current ? { session: session.current } : {}) },
      });
      session.current = result.session ?? session.current;
      return result;
    },
    gcTime: 0,
    retry: false,
  });
  const data = query.data;
  useEffect(() => {
    if (data?.kind === 'denied' || data?.kind === 'signed-out' || data?.kind === 'missing')
      clearPrivate(client, actor, key);
  }, [data, actor, client]);
  const search = useMemo(
    () => (text: string, signal: AbortSignal) => relationTargetSearch(text, signal, locale),
    [locale],
  );
  async function submit(command: Command): Promise<MutationResult> {
    await client.cancelQueries({ queryKey: key, exact: true });
    if (!alive.current) return unavailable;
    clearPrivate(client, actor, key);
    const result = await changeContextWorkspace({ data: command, headers: { 'X-CSRF-Token': csrfToken } });
    if (!alive.current) return result;
    session.current = result.session ?? session.current;
    if (result.kind === 'confirmed') {
      session.current = result.current.session ?? session.current;
      client.setQueryData(key, result.current);
    } else {
      // Definite denial/conflict and uncertain outcomes all drop the previous private payload before a current read.
      client.setQueryData(key, unavailable);
      await query.refetch();
    }
    return result;
  }
  return (
    <ContextDetailView
      id={id}
      locale={locale}
      data={query.isFetching ? null : query.isError ? unavailable : (data ?? null)}
      submit={submit}
      reload={() => query.refetch()}
      search={search}
    />
  );
}
/** Personal data starts after hydration and is scoped to this actual session subject. */
export function ContextSession(props: Mode) {
  const { state, subject, csrfToken } = useSession();
  const client = useQueryClient();
  const locale = getLocale();
  useEffect(() => {
    if (state !== 'signed-in') {
      void client.cancelQueries({ queryKey: prefix });
      clearPrivate(client);
    }
  }, [state, subject, client]);
  if (state === 'unknown') return <p role="status">{m.ctxw_loading()}</p>;
  if (state !== 'signed-in' || !subject || !csrfToken)
    return (
      <ContextFeedback locale={locale} failure={{ kind: state === 'signed-out' ? 'signed-out' : 'unavailable' }} />
    );
  const identity = `${subject}:${locale}:${props.mode}:${props.mode === 'detail' ? props.id : props.mode === 'directory' ? JSON.stringify(props.input) : ''}`;
  if (props.mode === 'directory')
    return <DirectorySession key={identity} actor={subject} locale={locale} input={props.input} />;
  if (props.mode === 'create')
    return <CreateSession key={identity} actor={subject} locale={locale} csrfToken={csrfToken} />;
  return <DetailSession key={identity} actor={subject} locale={locale} id={props.id} csrfToken={csrfToken} />;
}
export function ContextPending() {
  return <p role="status">{m.ctxw_loading()}</p>;
}
export function ContextRouteError() {
  const router = useRouter();
  return <ContextFeedback locale={getLocale()} failure={unavailable} retry={() => void router.invalidate()} />;
}
