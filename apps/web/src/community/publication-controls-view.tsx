import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from 'react';
import { EntityPicker, type EntityPickerSearch } from '@rezics/ui/entity-picker';
import { Cover } from '@rezics/ui/cover';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { ListRowControl } from '@rezics/ui/list-row';
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
import { useAuthoringDeparture } from '../threads/authoring-departure';
import type { ShelfContinuationResult } from './space-queries';

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
  const draft = useMemo(() => {
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
  }, [realmId, identity]);
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
  const unresolved = state.busy || state.outcome?.kind === 'unavailable';
  useAuthoringDeparture(
    unresolved || (!!state.target && state.outcome?.kind !== 'saved'),
    unresolved,
    JSON.stringify([
      realmId,
      reader,
      locale,
      draft.id,
      state.target?.id,
      state.action,
      state.outcome?.kind,
      state.busy,
    ]),
    undefined,
    draft.retire,
  );
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
    <div className="min-w-0 space-y-3 [overflow-wrap:anywhere]">
      <Button
        className="min-h-11 min-w-11 h-auto max-w-full whitespace-normal"
        variant="outline"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {m.realm_publication_curate()}
      </Button>
      {open ? (
        <div className="min-w-0 max-w-xl space-y-3">
          <ContentItemHeading level={3} className="text-lg font-semibold">
            {m.realm_publication_curate()}
          </ContentItemHeading>
          <p className="text-sm text-muted-foreground">{m.realm_publication_scope()}</p>
          <fieldset disabled={control.locked} className="min-w-0 space-y-3">
            {selected ? (
              <ContentItemFrame
                as="div"
                role="group"
                className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-3 py-3"
                aria-label={m.realm_publication_selected()}
              >
                <div data-content-item-slot="visual">
                  <Cover
                    subject={{ id: selected.id, title: selected.title, types: selected.types }}
                    cover={selected.cover}
                    src={coverSrc}
                    size="xs"
                    decorative
                  />
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <ContentItemHeading level={4} className="text-[17px] leading-snug font-semibold sm:text-lg">
                    {selected.title}
                  </ContentItemHeading>
                  {selected.typeName ? (
                    <p data-content-item-slot="metadata" className="text-sm text-muted-foreground">
                      {selected.typeName}
                    </p>
                  ) : null}
                  <p data-content-item-slot="preview" className="text-sm text-muted-foreground">
                    {m.realm_publication_confirm()}
                  </p>
                </div>
                <ListRowControl data-content-item-slot="actions" className="col-start-2 min-w-0">
                  <Button
                    className="min-h-11 min-w-11 h-auto max-w-full whitespace-normal"
                    variant="ghost"
                    onClick={() => control.choose(null)}
                  >
                    {m.realm_publication_clear()}
                  </Button>
                </ListRowControl>
              </ContentItemFrame>
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
            <ListRowControl data-content-item-slot="actions">
              <Button
                className="min-h-11 min-w-11 h-auto max-w-full whitespace-normal"
                disabled={!selected || control.locked}
                onClick={() => void control.change('publish')}
              >
                {m.realm_publication_publish()}
              </Button>
            </ListRowControl>
          </fieldset>
        </div>
      ) : null}
      {control.busy ? (
        <ContentItemFrame as="div" role="status" className="py-3 text-sm">
          {m.realm_publication_saving()}
        </ContentItemFrame>
      ) : null}
      {!control.busy && control.outcome ? (
        <ContentItemFrame as="div" role="status" className="min-w-0 space-y-2 py-3 text-sm">
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
              <ListRowControl data-content-item-slot="actions">
                <Button
                  className="min-h-11 min-w-11 h-auto max-w-full whitespace-normal"
                  variant="outline"
                  onClick={() => void control.retry()}
                >
                  {m.realm_publication_retry()}
                </Button>
              </ListRowControl>
            </>
          ) : null}
          {control.outcome.kind === 'conflict' ? (
            <>
              <p>{m.realm_publication_conflict()}</p>
              {control.outcome.currentHead ? (
                <ListRowControl data-content-item-slot="actions">
                  <Button
                    className="min-h-11 min-w-11 h-auto max-w-full whitespace-normal"
                    variant="outline"
                    onClick={() => void control.review()}
                  >
                    {control.action === 'withdraw'
                      ? m.realm_publication_review_withdraw()
                      : control.action === 'reject'
                        ? m.realm_publication_review_reject()
                        : m.realm_publication_review()}
                  </Button>
                </ListRowControl>
              ) : (
                <p>{m.realm_publication_head_unavailable()}</p>
              )}
              <ListRowControl data-content-item-slot="actions">
                <Button
                  className="min-h-11 min-w-11 h-auto max-w-full whitespace-normal"
                  variant="outline"
                  onClick={() => void refresh()}
                >
                  {m.realm_shelf_restart()}
                </Button>
              </ListRowControl>
            </>
          ) : null}
        </ContentItemFrame>
      ) : null}
    </div>
  );
}

type ShelfActivation = (action: (intent?: object) => Promise<void>, event: MouseEvent<HTMLButtonElement>) => void;

/** Only an explicit keyboard continuation can hand off focus, while its accepted read still owns the page. */
export function useShelfContinuationFocus(
  shelf: { continuation: ShelfContinuationResult | null; busy: boolean; failure: string | null },
  name: string,
) {
  const boundaryRef = useRef<HTMLHeadingElement>(null);
  const item = useRef<HTMLElement | null>(null);
  const recoveryRef = useRef<HTMLButtonElement>(null);
  const pending = useRef<{ intent: object; trigger: HTMLButtonElement } | null>(null);
  const [result, setResult] = useState<{ receipt: ShelfContinuationResult; text: string } | null>(null);
  const receipt = shelf.continuation;
  const activate: ShelfActivation = (action, event) => {
    pending.current = null;
    setResult(null);
    if (event.detail === 0 && event.currentTarget === document.activeElement) {
      pending.current = { intent: {}, trigger: event.currentTarget };
    }
    void action(pending.current?.intent);
  };

  usePublicationLayoutEffect(() => {
    if (!shelf.busy || !pending.current) return;
    const cancel = () => {
      pending.current = null;
    };
    const moved = (event: FocusEvent) => {
      if (event.target !== pending.current?.trigger) cancel();
    };
    document.addEventListener('pointerdown', cancel);
    document.addEventListener('focusin', moved);
    return () => {
      document.removeEventListener('pointerdown', cancel);
      document.removeEventListener('focusin', moved);
    };
  }, [shelf.busy]);

  usePublicationLayoutEffect(() => {
    const activation = pending.current;
    if (shelf.busy || !activation || receipt?.intent !== activation.intent) return;
    pending.current = null;
    if (!receipt.current()) return;
    // Disabling or removing the activated button can leave focus on the document body.
    const active = document.activeElement;
    if (active !== activation.trigger && active !== document.body) return;
    const target = shelf.failure ? recoveryRef.current : (item.current ?? boundaryRef.current);
    if (!target?.isConnected) return;
    target.focus();
    if (!shelf.failure) {
      setResult({
        receipt,
        text: receipt.count
          ? m.realm_shelf_added({ shelf: name, count: receipt.count })
          : m.realm_shelf_sparse({ shelf: name }),
      });
    }
  }, [receipt, shelf.busy, shelf.failure, name]);

  return {
    boundaryRef,
    itemRef: (node: HTMLElement | null) => {
      item.current = node;
    },
    recoveryRef,
    activate,
    firstId: receipt?.firstId ?? null,
    regionLabel: m.realm_shelf_added_region({ shelf: name }),
    announcement: result?.receipt.current() ? result.text : '',
  };
}

export function ShelfContinuation({
  next,
  busy,
  failure,
  load,
  retry,
  label,
  onContinue,
  recoveryRef,
}: {
  next: string | null;
  busy: boolean;
  failure: 'denied' | 'unavailable' | 'stale' | null;
  load: (restart?: boolean, intent?: object) => Promise<void>;
  retry: (intent?: object) => Promise<void>;
  label: string;
  onContinue?: ShelfActivation;
  recoveryRef?: React.Ref<HTMLButtonElement>;
}) {
  const activate = (event: MouseEvent<HTMLButtonElement>, action: (intent?: object) => Promise<void>) => {
    if (onContinue) onContinue(action, event);
    else void action();
  };
  return (
    <ContentItemFrame as="div" className="min-w-0 space-y-2 [overflow-wrap:anywhere]" aria-busy={busy}>
      {failure ? (
        <p role="status" className="text-sm text-muted-foreground">
          {failure === 'denied'
            ? m.realm_shelf_denied()
            : failure === 'stale'
              ? m.realm_shelf_stale()
              : m.realm_shelf_unavailable()}
        </p>
      ) : null}
      <ListRowControl data-content-item-slot="actions">
        {failure === 'stale' || failure === 'denied' ? (
          <Button
            ref={recoveryRef}
            className="min-h-11 min-w-11 h-auto max-w-full whitespace-normal"
            variant="outline"
            disabled={busy}
            onClick={(event) => activate(event, (intent) => load(true, intent))}
          >
            {m.realm_shelf_restart()}
          </Button>
        ) : failure === 'unavailable' ? (
          <Button
            ref={recoveryRef}
            className="min-h-11 min-w-11 h-auto max-w-full whitespace-normal"
            variant="outline"
            disabled={busy}
            onClick={(event) => activate(event, retry)}
          >
            {busy ? m.realm_shelf_loading() : m.realm_shelf_retry()}
          </Button>
        ) : next ? (
          <Button
            ref={recoveryRef}
            className="min-h-11 min-w-11 h-auto max-w-full whitespace-normal"
            variant="outline"
            disabled={busy}
            onClick={(event) => activate(event, (intent) => load(undefined, intent))}
          >
            {busy ? m.realm_shelf_loading() : label}
          </Button>
        ) : null}
      </ListRowControl>
    </ContentItemFrame>
  );
}
