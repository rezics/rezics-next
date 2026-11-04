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
import { EntityPicker, type EntityPickerSearch, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { Cover } from '@rezics/ui/cover';
import { FeedCardImageCredit } from '../features/feed/card-attribution';
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
import {
  admittedPublicationCommand,
  unavailablePublicationPreparation,
  type PublicationPrepare,
} from './realm-publication-preparation';
import type { PublishedSubject } from './space';
import { sessionQuery, useSession } from '../session/query';
import { useAuthoringDeparture } from '../threads/authoring-departure';
import type { ShelfContinuationResult } from './space-queries';
import { useSpacePageLifetime } from './space-page-lifetime';

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
  prepare: PublicationPrepare = unavailablePublicationPreparation,
  sourceIdentity?: object,
) {
  const locale = getLocale();
  const pageLifetime = useSpacePageLifetime();
  const pageRevision = useSyncExternalStore(
    pageLifetime?.subscribe ?? noSessionSubscribe,
    pageLifetime?.snapshot ?? noSessionRevision,
    pageLifetime?.snapshot ?? noSessionRevision,
  );
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
    pageLifetime?.scopeKey ?? null,
    pageRevision,
  ]);
  const transportIdentity = useMemo(() => ({}), [send, prepare, sourceIdentity]);
  const currentTransport = useRef(transportIdentity);
  currentTransport.current = transportIdentity;
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
        currentTransport.current === transportIdentity &&
        (!pageLifetime || (pageLifetime.admitted() && pageLifetime.snapshot() === pageRevision)) &&
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
    return createPublicationDraft(
      realmId,
      send,
      saved,
      () => subjects.current,
      enabled,
      {
        current,
        watch: (listener) => {
          const stopSession = source?.subscribe(listener);
          const stopPage = pageLifetime?.subscribe(listener);
          return () => {
            stopSession?.();
            stopPage?.();
          };
        },
        startDisconnected: true,
      },
      async (input) => {
        const result = await prepare(input);
        return result.kind === 'ready' && result.preparation.viewer.accountId !== session.subject
          ? { kind: 'denied' }
          : result;
      },
    );
  }, [realmId, identity, transportIdentity]);
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
    current: draft.current,
  };
}

type PublicationControlsProps = {
  search?: EntityPickerSearch | undefined;
  control: ReturnType<typeof usePublicationControls>;
  refresh: () => Promise<void>;
  onCommand?: ((event: MouseEvent<HTMLButtonElement>) => void) | undefined;
};

export function PublicationControls(props: PublicationControlsProps) {
  return <PublicationControlsVisit key={props.control.scope} {...props} />;
}

function PublicationControlsVisit({ control, refresh, search, onCommand }: PublicationControlsProps) {
  const [open, setOpen] = useState(false);
  const locale = getLocale();
  const searchSubjects = useMemo(() => search ?? publicationSubjectSearch(locale), [search, locale]);
  const selected = control.target;
  const preparation = control.preparation;
  const presentation = preparation?.subject.presentation;
  const title = presentation?.label.state === 'available' ? presentation.label.value : m.realm_publication_selected();
  useEffect(() => {
    if (control.reviewAction) setOpen(true);
  }, [control.reviewAction, control.target?.id]);
  const opener = useRef<HTMLButtonElement>(null);
  const picker = useRef<HTMLDivElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const focusRequest = useRef<{
    scope: string;
    targetId: string | null;
    destination: 'summary' | 'picker';
    origin: HTMLElement;
  } | null>(null);
  const rendered = useRef({ scope: control.scope, targetId: selected?.id ?? null, open });
  rendered.current = { scope: control.scope, targetId: selected?.id ?? null, open };

  usePublicationLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      focusRequest.current = null;
    };
  }, []);
  usePublicationLayoutEffect(() => {
    const request = focusRequest.current;
    if (!request) return;
    focusRequest.current = null;
    if (
      !mounted.current ||
      !rendered.current.open ||
      rendered.current.scope !== request.scope ||
      rendered.current.targetId !== request.targetId ||
      (document.activeElement !== request.origin && document.activeElement !== document.body)
    )
      return;
    const destination =
      request.destination === 'summary'
        ? summary.current?.querySelector<HTMLElement>('[data-content-item-slot="title"]')
        : picker.current?.querySelector<HTMLInputElement>('input');
    if (destination?.isConnected) destination.focus();
  });

  usePublicationLayoutEffect(() => {
    if (!control.reviewAction || !open || !selected) return;
    const active = document.activeElement;
    if (active === document.body || (active instanceof HTMLElement && active.getAttribute('role') === 'menuitem'))
      summary.current?.querySelector<HTMLElement>('[data-content-item-slot="title"]')?.focus();
  }, [control.scope, control.reviewAction, selected?.id, open]);

  const choose = (subject: EntityPickerSubject | undefined) => {
    const scope = control.scope;
    const current = rendered.current;
    if (!mounted.current || !current.open || current.scope !== scope || current.targetId !== (selected?.id ?? null))
      return;
    const active = document.activeElement;
    if (subject && active instanceof HTMLElement && picker.current?.contains(active)) {
      focusRequest.current = { scope, targetId: subject.id, destination: 'summary', origin: active };
    }
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
  };

  return (
    <div className="min-w-0 space-y-3 [overflow-wrap:anywhere]">
      <Button
        ref={opener}
        className="min-h-11 min-w-11 h-auto max-w-full whitespace-normal"
        variant="outline"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            focusRequest.current = null;
            opener.current?.focus();
          }
          setOpen(!open);
        }}
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
                  {presentation?.cover.state === 'available' ? (
                    <Cover
                      subject={{ id: preparation!.subject.currentId, title, types: [] }}
                      cover={presentation.cover.value}
                      src={coverSrc}
                      size="xs"
                      decorative
                    />
                  ) : null}
                </div>
                <div ref={summary} className="min-w-0 flex-1 space-y-1">
                  <ContentItemHeading
                    level={4}
                    tabIndex={-1}
                    className="text-[17px] leading-snug font-semibold sm:text-lg"
                  >
                    <bdi lang={presentation?.label.state === 'available' ? presentation.label.language : undefined}>
                      {title}
                    </bdi>
                  </ContentItemHeading>
                  {presentation && presentation.label.state !== 'available' ? (
                    <p
                      data-content-item-slot="metadata"
                      data-publication-label={presentation.label.state}
                      className="text-sm text-muted-foreground"
                    >
                      {presentation.label.state === 'empty'
                        ? m.realm_publication_label_empty()
                        : presentation.label.state === 'concealed'
                          ? m.realm_publication_label_concealed()
                          : m.realm_publication_label_unavailable()}
                    </p>
                  ) : null}
                  {presentation?.cover.state === 'available' ? (
                    <FeedCardImageCredit cover={presentation.cover.value} locale={locale} />
                  ) : presentation ? (
                    <p data-publication-cover={presentation.cover.state} className="text-sm text-muted-foreground">
                      {presentation.cover.state === 'empty'
                        ? m.realm_publication_cover_empty()
                        : presentation.cover.state === 'concealed'
                          ? m.realm_publication_cover_concealed()
                          : m.realm_publication_cover_unavailable()}
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
                    onClick={(event) => {
                      const scope = control.scope;
                      const current = rendered.current;
                      if (
                        mounted.current &&
                        current.open &&
                        current.scope === scope &&
                        current.targetId === selected.id &&
                        document.activeElement === event.currentTarget
                      ) {
                        focusRequest.current = {
                          scope,
                          targetId: null,
                          destination: 'picker',
                          origin: event.currentTarget,
                        };
                      }
                      control.choose(null);
                    }}
                  >
                    {m.realm_publication_clear()}
                  </Button>
                </ListRowControl>
              </ContentItemFrame>
            ) : (
              <div ref={picker}>
                <EntityPicker
                  key={control.scope}
                  disabled={control.locked}
                  label={m.realm_publication_choose()}
                  value={[]}
                  search={searchSubjects}
                  src={coverSrc}
                  onValueChange={(items) => choose(items[0])}
                />
              </div>
            )}
            {preparation ? (
              <div className="min-w-0 space-y-2" aria-label={m.realm_publication_read()}>
                <p>
                  {m.realm_publication_prepared_realm({
                    realm: preparation.realm.title,
                    host: preparation.realm.hostTitle,
                  })}
                </p>
                <p className="text-sm">
                  {m.realm_publication_prepared_subject({
                    original: preparation.subject.originalId,
                    current: preparation.subject.currentId,
                  })}
                </p>
                <p>
                  {preparation.current === null
                    ? m.realm_publication_no_decision()
                    : preparation.current.verdict === 'adopt'
                      ? m.realm_publication_current_adopted()
                      : preparation.current.verdict === 'withdraw'
                        ? m.realm_publication_current_withdrawn()
                        : m.realm_publication_current_rejected()}
                </p>
                {preparation.current ? (
                  <p>
                    <time dateTime={preparation.current.decidedAt}>
                      {m.realm_publication_decided_at({ at: preparation.current.decidedAt })}
                    </time>
                  </p>
                ) : null}
              </div>
            ) : null}
            <ListRowControl data-content-item-slot="actions" className="flex flex-wrap gap-2">
              {(['publish', 'withdraw', 'reject'] as const).map((action) => (
                <Button
                  key={action}
                  className="min-h-11 min-w-11 h-auto max-w-full whitespace-normal"
                  disabled={
                    !selected || control.locked || !preparation || !admittedPublicationCommand(preparation, action)
                  }
                  onClick={(event) => {
                    onCommand?.(event);
                    void control.change(action);
                  }}
                >
                  {action === 'publish'
                    ? m.realm_publication_publish()
                    : action === 'withdraw'
                      ? m.realm_publication_review_withdraw()
                      : m.realm_publication_review_reject()}
                </Button>
              ))}
            </ListRowControl>
          </fieldset>
        </div>
      ) : null}
      {control.preparationState && control.preparationState !== 'ready' ? (
        <div role="status" className="min-w-0 space-y-2 text-sm">
          {control.preparationState === 'loading'
            ? m.realm_publication_reading()
            : control.preparationState === 'denied'
              ? m.realm_publication_denied()
              : control.preparationState === 'unavailable'
                ? m.realm_publication_preparation_unavailable()
                : null}
        </div>
      ) : null}
      {(selected || control.preparationState || control.outcome?.kind === 'unavailable') && !control.busy ? (
        <Button
          className="min-h-11 min-w-11 h-auto max-w-full whitespace-normal"
          variant="outline"
          disabled={control.preparationState === 'loading'}
          onClick={() => void control.inspect()}
        >
          {m.realm_publication_read()}
        </Button>
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
                  onClick={(event) => {
                    onCommand?.(event);
                    void control.retry();
                  }}
                >
                  {m.realm_publication_retry()}
                </Button>
              </ListRowControl>
            </>
          ) : null}
          {control.outcome.kind === 'conflict' ? (
            <>
              <p>{m.realm_publication_conflict()}</p>
              <ListRowControl data-content-item-slot="actions">
                <Button
                  className="min-h-11 min-w-11 h-auto max-w-full whitespace-normal"
                  variant="outline"
                  disabled={control.preparationState === 'loading'}
                  onClick={() => void control.review()}
                >
                  {m.realm_publication_review()}
                </Button>
              </ListRowControl>
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
