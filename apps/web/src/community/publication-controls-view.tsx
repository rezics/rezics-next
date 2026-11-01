import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { EntityPicker, type EntityPickerSearch } from '@rezics/ui/entity-picker';
import { Cover } from '@rezics/ui/cover';
import { Button } from '@rezics/ui/shadcn/button';
import { coverSrc } from '../media/cover-src';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import {
  createPublicationDraft,
  publicationSubjectSearch,
  type PublicationSend,
  type PublicationTarget,
} from './publication-subject-picker';
import type { PublicationChange } from './publication-controls';
import type { PublishedSubject } from './space';
import { sessionQuery, useSession } from '../session/query';

export type { PublicationSend, PublicationTarget } from './publication-subject-picker';

type SessionRecord = { state: string; subject?: string | null; csrfToken?: string | null };
type PublicationSessionSource = {
  readonly id: number;
  read: () => SessionRecord | undefined;
  dataUpdateCount: () => number;
  dataUpdatedAt: () => number;
  snapshot: () => number;
  subscribe: (listener: () => void) => () => void;
};

const publicationSessionSources = new WeakMap<QueryClient, PublicationSessionSource>();
let nextPublicationSessionSourceId = 0;

function publicationSessionSource(client: QueryClient): PublicationSessionSource {
  const existing = publicationSessionSources.get(client);
  if (existing) return existing;
  const read = () => client.getQueryData<SessionRecord>(sessionQuery.queryKey);
  const dataUpdateCount = () => client.getQueryState(sessionQuery.queryKey)?.dataUpdateCount ?? 0;
  const dataUpdatedAt = () => client.getQueryState(sessionQuery.queryKey)?.dataUpdatedAt ?? 0;
  const identity = () => {
    const value = read();
    return JSON.stringify([
      value?.state ?? 'unknown',
      value?.subject ?? null,
      value?.csrfToken ?? null,
      dataUpdateCount(),
      dataUpdatedAt(),
    ]);
  };
  let previous = identity();
  let revision = 0;
  const listeners = new Set<() => void>();
  client.getQueryCache().subscribe(({ query }) => {
    if (query.queryKey.length !== 1 || query.queryKey[0] !== sessionQuery.queryKey[0]) return;
    const next = identity();
    if (next === previous) return;
    previous = next;
    revision++;
    for (const listener of listeners) listener();
  });
  const source: PublicationSessionSource = {
    id: ++nextPublicationSessionSourceId,
    read,
    dataUpdateCount,
    dataUpdatedAt,
    snapshot: () => revision,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  publicationSessionSources.set(client, source);
  return source;
}

const noSessionSubscribe = () => () => {};
const noSessionRevision = () => 0;
const usePublicationLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function usePublicationControls(
  realmId: string,
  send: PublicationSend,
  saved: (input: PublicationChange, target: PublicationTarget, head: string) => void,
  currentSubjects: PublishedSubject[] = [],
  enabled = true,
  reader = '',
) {
  const locale = getLocale();
  const queryClient = useContext(QueryClientContext) ?? null;
  const session = useSession();
  const source = queryClient ? publicationSessionSource(queryClient) : null;
  const revision = useSyncExternalStore(
    source?.subscribe ?? noSessionSubscribe,
    source?.snapshot ?? noSessionRevision,
    source?.snapshot ?? noSessionRevision,
  );
  const cached = source?.read();
  const dataUpdateCount = source?.dataUpdateCount() ?? 0;
  const dataUpdatedAt = source?.dataUpdatedAt() ?? 0;
  const cacheIdentity = JSON.stringify([
    cached?.state ?? 'unknown',
    cached?.subject ?? null,
    cached?.csrfToken ?? null,
  ]);
  const sessionIdentity = JSON.stringify([session.state, session.subject ?? null, session.csrfToken]);
  const ready =
    !!source &&
    cached?.state === session.state &&
    (cached?.subject ?? null) === (session.subject ?? null) &&
    (cached?.csrfToken ?? null) === session.csrfToken &&
    session.state === 'signed-in' &&
    typeof session.subject === 'string' &&
    session.subject.length > 0 &&
    (!reader || reader === session.subject) &&
    typeof session.csrfToken === 'string' &&
    session.csrfToken.length > 0;
  const identity = JSON.stringify([
    realmId,
    reader,
    locale,
    enabled,
    ready,
    sessionIdentity,
    source?.id ?? null,
    revision,
    dataUpdateCount,
    dataUpdatedAt,
    cacheIdentity,
  ]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const subjects = useRef(currentSubjects);
  subjects.current = currentSubjects;
  const draft = useMemo(
    () => {
      const current = () => {
        const live = source?.read();
        return (
          ready &&
          currentIdentity.current === identity &&
          getLocale() === locale &&
          !!queryClient &&
          !!source &&
          publicationSessionSource(queryClient) === source &&
          source.snapshot() === revision &&
          source.dataUpdateCount() === dataUpdateCount &&
          source.dataUpdatedAt() === dataUpdatedAt &&
          JSON.stringify([live?.state ?? 'unknown', live?.subject ?? null, live?.csrfToken ?? null]) === cacheIdentity
        );
      };
      return createPublicationDraft(realmId, send, saved, () => subjects.current, enabled, {
        current,
        ...(source ? { watch: source.subscribe } : {}),
        startDisconnected: true,
      });
    },
    [realmId, identity],
  );
  const previousDraft = useRef(draft);
  usePublicationLayoutEffect(() => {
    if (previousDraft.current !== draft) {
      previousDraft.current.retire();
      previousDraft.current = draft;
    }
    return draft.connect();
  }, [draft]);
  const state = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const actions = draft.bind();
  return {
    ...state,
    locked: !enabled || !draft.current() || state.busy || state.outcome?.kind === 'unavailable',
    ...actions,
    scope: `${realmId}:${reader}:${locale}:${source?.id ?? 'no-session-cache'}:${revision}:${draft.id}`,
  };
}

export function PublicationControls({
  control,
  refresh,
  search,
}: {
  search?: EntityPickerSearch | undefined;
  control: ReturnType<typeof usePublicationControls>;
  refresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const locale = getLocale();
  const searchSubjects = useMemo(() => search ?? publicationSubjectSearch(locale), [search, locale]);
  const selected = control.target;
  return (
    <div className="space-y-3">
      <Button variant="outline" aria-expanded={open} onClick={() => setOpen(!open)}>
        {m.realm_publication_curate()}
      </Button>
      {open ? (
        <div className="max-w-xl space-y-3 rounded-xl bg-muted/40 p-4">
          <p className="text-sm text-muted-foreground">{m.realm_publication_scope()}</p>
          <fieldset disabled={control.locked} className="space-y-3">
            {selected ? (
              <div role="group" className="flex min-w-0 items-start gap-3" aria-label={m.realm_publication_selected()}>
                <Cover
                  subject={{ id: selected.id, title: selected.title, types: selected.types }}
                  cover={selected.cover}
                  src={coverSrc}
                  size="xs"
                  decorative
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="font-medium [overflow-wrap:anywhere]">{selected.title}</p>
                  {selected.typeName ? <p className="text-xs text-muted-foreground">{selected.typeName}</p> : null}
                  <p className="text-sm text-muted-foreground">{m.realm_publication_confirm()}</p>
                </div>
                <Button variant="ghost" onClick={() => control.choose(null)}>
                  {m.realm_publication_clear()}
                </Button>
              </div>
            ) : (
              <EntityPicker
                key={control.scope}
                disabled={control.locked}
                label={m.realm_publication_choose()}
                value={[]}
                search={searchSubjects}
                src={coverSrc}
                onValueChange={(items) => {
                  const subject = items[0];
                  control.choose(
                    subject
                      ? {
                          id: subject.id,
                          title: subject.title,
                          labels: { [locale]: subject.title },
                          label: subject.title,
                          types: [...subject.types],
                          typeName: subject.typeLabel,
                          cover: subject.cover,
                        }
                      : null,
                  );
                }}
              />
            )}
            <Button disabled={!selected || control.locked} onClick={() => void control.change('publish')}>
              {m.realm_publication_publish()}
            </Button>
          </fieldset>
        </div>
      ) : null}
      {control.busy ? <p role="status">{m.realm_publication_saving()}</p> : null}
      {!control.busy && control.outcome ? (
        <div role="status" className="space-y-2 text-sm">
          {control.outcome.kind === 'saved' ? (
            <p>
              {control.action === 'publish'
                ? m.realm_publication_saved()
                : control.action === 'reject'
                  ? m.realm_publication_rejected()
                  : m.realm_publication_removed()}
            </p>
          ) : null}
          {control.outcome.kind === 'denied' ? <p>{m.realm_publication_denied()}</p> : null}
          {control.outcome.kind === 'invalid' ? <p>{m.realm_publication_invalid()}</p> : null}
          {control.outcome.kind === 'unavailable' ? (
            <>
              <p>{m.realm_publication_uncertain()}</p>
              <Button variant="outline" onClick={() => void control.retry()}>
                {m.realm_publication_retry()}
              </Button>
            </>
          ) : null}
          {control.outcome.kind === 'conflict' ? (
            <>
              <p>{m.realm_publication_conflict()}</p>
              {control.outcome.currentHead ? (
                <Button variant="outline" onClick={() => void control.review()}>
                  {control.action === 'withdraw'
                    ? m.realm_publication_review_withdraw()
                    : control.action === 'reject'
                      ? m.realm_publication_review_reject()
                      : m.realm_publication_review()}
                </Button>
              ) : (
                <p>{m.realm_publication_head_unavailable()}</p>
              )}
              <Button variant="outline" onClick={() => void refresh()}>
                {m.realm_shelf_restart()}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ShelfContinuation({
  next,
  busy,
  failure,
  load,
  label,
}: {
  next: string | null;
  busy: boolean;
  failure: 'denied' | 'unavailable' | 'stale' | null;
  load: (restart?: boolean) => Promise<void>;
  label: string;
}) {
  return (
    <div className="space-y-2" aria-busy={busy}>
      {failure ? (
        <p role="status" className="text-sm text-muted-foreground">
          {failure === 'denied'
            ? m.realm_shelf_denied()
            : failure === 'stale'
              ? m.realm_shelf_stale()
              : m.realm_shelf_unavailable()}
        </p>
      ) : null}
      {failure === 'stale' || failure === 'denied' ? (
        <Button variant="outline" disabled={busy} onClick={() => void load(true)}>
          {m.realm_shelf_restart()}
        </Button>
      ) : next ? (
        <Button variant="outline" disabled={busy} onClick={() => void load()}>
          {busy ? m.realm_shelf_loading() : label}
        </Button>
      ) : null}
    </div>
  );
}
