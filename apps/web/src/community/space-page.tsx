import type { PublicationPrepare } from './realm-publication-preparation';
import { ResourceAccessLink } from '../accounts/resource-access/link';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { ListRow } from '@rezics/ui/list-row';
import { placeholderColors, sharedRatio, type CoverSubject } from '@rezics/ui/cover';
import { CoverCard, CoverRow } from '@rezics/ui/cover-card';
import { coverSrc } from '../media/cover-src';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { subjectHref } from '../subject/subject-href';
import { RealmMembership } from './realm-membership';
import { RealmBansPanel } from './realm-bans-panel';
import { RealmMembersEntry } from './members/entry';
import type { PublishedSubject, RealmBoard, RealmHome, SpacePageData } from './space';
import { SpaceSetupEntry, useSpaceSetupRead } from './space-setup-page';
import { FollowTargetControl } from '../library/follow-target-control';
import { useSession } from '../session/query';
import { useShelfList } from './space-queries';
import { nativeHomeBinding, sameNativeHomeBinding, useSpacePageLifetime } from './space-page-lifetime';
import {
  changeRealmPublication,
  readRealmBoards,
  readRealmPublications,
  readRealmPublicationPreparation,
} from './space-actions';
import {
  PublicationControls,
  ShelfContinuation,
  useShelfContinuationFocus,
  usePublicationControls,
  type PublicationSend,
} from './publication-controls-view';
import type { ShelfPage } from './space';
import type { ReadCredentialMode } from '../kernel/credential';
import { ContainerLifecyclePanel } from './container-lifecycle-controls';
import type { ContainerLifecycleAdapter } from './container-lifecycle';
import { RealmAppearancePanel } from './realm-presentation-panel';
import { RealmClaimPanel } from './realm-claim-panel';
import type { EntityPickerSearch } from '@rezics/ui/entity-picker';
import {
  sameRealmClaimSource,
  type RealmClaimAdapter,
  type RealmClaimRead,
  type RealmClaimSnapshot,
} from './realm-claim';
import { RealmHomeHeader } from './realm-home-header';
import { RealmCatalogueCurrent } from './realm-catalogue-current';
import { Button } from '@rezics/ui/shadcn/button';
import { CommunityManagementContext, type CommunityManagementOperation } from './community-management';
import { AuthoringDepartureBoundary } from '../threads/authoring-departure';
import { nativeRealmHomeShelves, type NativeRealmHomeOperations } from './realm-home-native';
import { realmReadingReturn, realmReadingSelection, realmShelfReturn } from './realm-reading-return';
import { withSubjectVisitReturn } from '../features/pages/subject-visit-navigation';
import { requestLanguages } from '../kernel/languages';
import {
  useRealmCompletionFocus,
  type RealmCompleted,
  type RealmPublicationCompletion,
  type RealmCompletionFocus,
} from './realm-community/completion';
import type { PublicationChange } from './publication-controls';

export type { RealmPublicationCompletion } from './realm-community/completion';

function subjectTitle(subject: PublishedSubject, locale: string): string {
  return (
    subject.labels[locale] ??
    subject.label ??
    subject.labels.en ??
    Object.values(subject.labels)[0] ??
    m.library_subject_unavailable()
  );
}

function purposeLabel(purpose: RealmBoard['purpose']): string {
  return purpose === 'reviews' ? m.realm_board_purpose_reviews() : m.realm_board_purpose_discussion();
}

function Boards({
  boards,
  unavailable,
  continuation,
  complete,
  focus,
  returnFor,
  current,
}: {
  returnFor: (id: string) => string | undefined;
  current: () => boolean;
  boards: RealmBoard[];
  unavailable: number;
  continuation: React.ReactNode;
  complete: boolean;
  focus: ReturnType<typeof useShelfContinuationFocus>;
}) {
  return (
    <section className="space-y-4" aria-labelledby="realm-boards-heading">
      <h2 ref={focus.boundaryRef} tabIndex={-1} id="realm-boards-heading" className="text-xl font-semibold">
        {m.realm_boards_heading()}
      </h2>
      {boards.length ? (
        <ul className="space-y-1">
          {boards.map((board) => (
            <ListRow
              key={board.id}
              id={`realm-board-${board.id}`}
              ref={board.id === focus.firstId ? focus.itemRef : null}
              tabIndex={-1}
              aria-label={board.id === focus.firstId ? focus.regionLabel : undefined}
              className="flex items-start gap-4 rounded-xl px-4 py-3 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <Link
                to="/boards/$id"
                params={{ id: board.id }}
                search={returnFor(board.id) ? { returnTo: returnFor(board.id)! } : {}}
                onClick={(event) => {
                  if (!current()) event.preventDefault();
                }}
                onAuxClick={(event) => {
                  if (!current()) event.preventDefault();
                }}
                onContextMenu={(event) => {
                  if (!current()) event.preventDefault();
                }}
                className="absolute inset-1 z-0 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                data-slot="list-row-link"
              >
                <span className="sr-only">{board.title ?? m.threads_untitled()}</span>
              </Link>
              <div className="min-w-0 flex-1 space-y-1">
                <h3 className="font-semibold">{board.title ?? m.threads_untitled()}</h3>
                {board.description ? (
                  <p className="text-sm leading-relaxed text-muted-foreground">{board.description}</p>
                ) : null}
                <p className="text-xs font-medium text-muted-foreground">{purposeLabel(board.purpose)}</p>
              </div>
              {board.visibility === 'draft' || board.visibility === 'protected' ? (
                <p className="relative z-10 shrink-0 text-xs text-muted-foreground">
                  {board.visibility === 'draft' ? m.realm_board_draft() : m.realm_board_protected()}
                </p>
              ) : null}
            </ListRow>
          ))}
        </ul>
      ) : unavailable === 0 && complete ? (
        <p className="text-muted-foreground">{m.realm_boards_empty()}</p>
      ) : null}
      {unavailable > 0 ? <p className="text-muted-foreground">{m.realm_boards_unavailable()}</p> : null}
      {continuation}
      <p role="status" className="sr-only">
        {focus.announcement}
      </p>
    </section>
  );
}

function Published({
  realm,
  control,
  editable,
  continuation,
  complete,
  refresh,
  search,
  focus,
  returnFor,
  current,
  onCommand,
}: {
  returnFor: (id: string) => string | undefined;
  current: () => boolean;
  realm: RealmHome;
  control: ReturnType<typeof usePublicationControls>;
  editable: boolean;
  continuation: React.ReactNode;
  complete: boolean;
  refresh: () => Promise<void>;
  search?: EntityPickerSearch | undefined;
  focus: ReturnType<typeof useShelfContinuationFocus>;
  onCommand?: ((event: React.MouseEvent<HTMLButtonElement>) => void) | undefined;
}) {
  const locale = getLocale();
  const titled: { subject: PublishedSubject; cover: CoverSubject }[] = realm.published.map((subject) => ({
    subject,
    cover: { id: subject.id, title: subjectTitle(subject, locale), types: subject.types },
  }));
  const ratio = sharedRatio(titled.map((item) => item.cover));
  return (
    <section className="space-y-4" aria-labelledby="realm-published-heading">
      <h2 ref={focus.boundaryRef} tabIndex={-1} id="realm-published-heading" className="text-xl font-semibold">
        {m.realm_published_heading()}
      </h2>
      <p className="text-sm text-muted-foreground">{m.realm_publication_open_view()}</p>
      <p className="max-w-prose text-sm text-muted-foreground">{m.realm_catalogue_publications_context()}</p>
      {editable ? (
        <PublicationControls control={control} refresh={refresh} search={search} onCommand={onCommand} />
      ) : null}
      {titled.length ? (
        <CoverRow ratio={ratio} label={`${m.realm_published_heading()} (${titled.length})`}>
          {titled.map(({ subject, cover }) => (
            <div
              key={subject.id}
              id={`realm-publication-${subject.id}`}
              onClickCapture={(event) => {
                if (!current()) {
                  event.preventDefault();
                  event.stopPropagation();
                }
              }}
              onAuxClickCapture={(event) => {
                if (!current()) {
                  event.preventDefault();
                  event.stopPropagation();
                }
              }}
              onContextMenu={(event) => {
                if (!current()) event.preventDefault();
              }}
              ref={subject.id === focus.firstId ? focus.itemRef : undefined}
              role="group"
              tabIndex={-1}
              aria-label={subject.id === focus.firstId ? focus.regionLabel : undefined}
              className="h-full focus-visible:outline-2 focus-visible:outline-ring"
            >
              <CoverCard
                href={withSubjectVisitReturn(
                  `${subjectHref({ id: subject.id, label: subjectTitle(subject, locale) }, locale).href}?realm=${encodeURIComponent(realm.id)}`,
                  returnFor(subject.id) ?? '',
                  locale,
                )}
                cover={{ subject: cover, cover: subject.cover, src: coverSrc }}
                title={cover.title}
                secondary={subject.typeName}
                menuLabel={m.realm_publication_actions({ title: cover.title })}
                {...(editable
                  ? {
                      menuEntries: [
                        {
                          type: 'item' as const,
                          label: m.realm_publication_withdraw(),
                          disabled: control.locked || !subject.publicationId,
                          onSelect: () => void control.choose({ ...subject, title: cover.title }, 'withdraw'),
                        },
                        {
                          type: 'destructive' as const,
                          label: m.realm_publication_reject(),
                          disabled: control.locked || !subject.publicationId,
                          onSelect: () => void control.choose({ ...subject, title: cover.title }, 'reject'),
                        },
                      ],
                    }
                  : {})}
              />
            </div>
          ))}
        </CoverRow>
      ) : null}
      {(realm.unavailablePublished ?? 0) > 0 ? (
        <p className="text-muted-foreground">{m.realm_published_unavailable()}</p>
      ) : !titled.length && complete ? (
        <p className="text-muted-foreground">{m.realm_published_empty()}</p>
      ) : null}
      {continuation}
      <p role="status" className="sr-only">
        {focus.announcement}
      </p>
    </section>
  );
}

export type RealmShelfTransport = {
  boards: (input: { cursor?: string; credentialMode: ReadCredentialMode }) => Promise<ShelfPage<RealmBoard>>;
  publications: (input: {
    cursor?: string;
    credentialMode: ReadCredentialMode;
  }) => Promise<ShelfPage<PublishedSubject>>;
  change: PublicationSend;
  prepare?: PublicationPrepare;
};

/** One reusable shelf region; its stories exercise the same controls used on Space and Realm pages. */
export function RealmShelf({
  realm,
  transport,
  frozen = false,
  search,
  returnTo,
  onReadingChange,
  onCompleted,
}: {
  returnTo?: string;
  onReadingChange?: (href: string) => void;
  onCompleted?: RealmCompleted<RealmPublicationCompletion>;
  realm: RealmHome;
  transport?: RealmShelfTransport;
  frozen?: boolean;
  search?: EntityPickerSearch | undefined;
}) {
  const { state, csrfToken, subject: reader } = useSession();
  const lifetime = useSpacePageLifetime();
  const locale = getLocale();
  const selection = realmReadingSelection(returnTo);
  const lease = useMemo(
    () => ({ active: true, connected: false }),
    [realm, transport, returnTo, lifetime, state, csrfToken, reader, locale, frozen],
  );
  const latestLease = useRef(lease);
  if (latestLease.current !== lease) latestLease.current.active = false;
  latestLease.current = lease;
  useEffect(() => {
    lease.connected = true;
    return () => {
      lease.connected = false;
    };
  }, [lease]);
  const current = () => lease.active && lease.connected && (!lifetime || lifetime.current());
  const captureFocus = useRealmCompletionFocus();
  const commandFocus = useRef<RealmCompletionFocus | null>(null);
  const [completed, setCompleted] = useState<{
    input: PublicationChange;
    head: string;
    intent: object;
    current: () => boolean;
    focus: RealmCompletionFocus | null;
  } | null>(null);
  const delivered = useRef(new WeakSet<object>());
  const boards = useShelfList(
    {
      items: realm.boards,
      next: realm.boardNext ?? null,
      unavailable: realm.unavailableBoards ?? 0,
      credentialMode: realm.credentialMode ?? 'anonymous',
    },
    transport?.boards ?? ((input) => readRealmBoards({ data: { realmId: realm.id, ...input } })),
    lifetime,
    !transport?.boards,
  );
  const publications = useShelfList(
    {
      items: realm.published,
      next: realm.publicationNext ?? null,
      unavailable: realm.unavailablePublished ?? 0,
      credentialMode: realm.credentialMode ?? 'anonymous',
    },
    transport?.publications ?? ((input) => readRealmPublications({ data: { realmId: realm.id, ...input } })),
    lifetime,
    !transport?.publications,
  );
  const boardFocus = useShelfContinuationFocus(boards, m.realm_boards_heading());
  const publicationFocus = useShelfContinuationFocus(publications, m.realm_published_heading());
  const returnFor = (node: 'boards' | 'publications', id?: string) =>
    realmShelfReturn({
      href: returnTo ?? `/${locale}/realms/${encodeURIComponent(realm.id)}`,
      locale,
      node,
      cursor: id ? (node === 'boards' ? boards.cursors : publications.cursors).get(id) : undefined,
      ...(id ? { id } : {}),
    });
  const restore = useRef<{ lease: typeof lease; started: boolean; focused: boolean }>({
    lease,
    started: false,
    focused: false,
  });
  if (restore.current.lease !== lease) restore.current = { lease, started: false, focused: false };
  useEffect(() => {
    queueMicrotask(() => {
      if (!current() || frozen || restore.current.started) return;
      restore.current.started = true;
      if (selection.cursor) void (selection.node === 'boards' ? boards : publications).restore(selection.cursor);
    });
  }, [lease]);
  useEffect(() => {
    if (!selection.node) return;
    const cancel = () => {
      restore.current.focused = true;
    };
    document.addEventListener('pointerdown', cancel);
    document.addEventListener('focusin', cancel);
    return () => {
      document.removeEventListener('pointerdown', cancel);
      document.removeEventListener('focusin', cancel);
    };
  }, [lease]);
  useEffect(() => {
    queueMicrotask(() => {
      if (!selection.node || frozen || !current() || restore.current.focused) return;
      const shelf = selection.node === 'boards' ? boards : publications;
      if (shelf.busy || (selection.cursor && !shelf.continuation)) return;
      if (shelf.continuation && !shelf.continuation.current()) return;
      restore.current.focused = true;
      // A returning reader must not take focus back from an intervening user action.
      if (document.activeElement !== document.body) return;
      const focus = selection.node === 'boards' ? boardFocus : publicationFocus;
      const selected = selection.focus ? document.getElementById(selection.focus) : null;
      (shelf.failure ? focus.recoveryRef.current : (selected ?? focus.boundaryRef.current))?.focus();
    });
  }, [lease, boards.busy, boards.continuation, publications.busy, publications.continuation]);
  useEffect(() => {
    const receipt = boards.continuation;
    if (frozen || !current() || boards.failure || !receipt?.current()) return;
    const href = realmShelfReturn({
      href: returnTo ?? `/${locale}/realms/${realm.id}`,
      locale,
      node: 'boards',
      cursor: receipt.cursor,
    });
    if (href) onReadingChange?.(href);
  }, [boards.continuation]);
  useEffect(() => {
    const receipt = publications.continuation;
    if (frozen || !current() || publications.failure || !receipt?.current()) return;
    const href = realmShelfReturn({
      href: returnTo ?? `/${locale}/realms/${realm.id}`,
      locale,
      node: 'publications',
      cursor: receipt.cursor,
    });
    if (href) onReadingChange?.(href);
  }, [publications.continuation]);
  const boardRestoring =
    !frozen && selection.node === 'boards' && Boolean(selection.cursor) && (!boards.continuation || boards.busy);
  const publicationRestoring =
    !frozen &&
    selection.node === 'publications' &&
    Boolean(selection.cursor) &&
    (!publications.continuation || publications.busy);
  const sendPublication = useCallback<PublicationSend>(
    (input) =>
      transport?.change
        ? transport.change(input)
        : csrfToken
          ? changeRealmPublication({ data: input, headers: { 'X-CSRF-Token': csrfToken } })
          : Promise.resolve({ kind: 'denied' }),
    [transport?.change, csrfToken],
  );
  const preparePublication = useCallback<PublicationPrepare>(
    (input) => (transport?.prepare ? transport.prepare(input) : readRealmPublicationPreparation({ data: input })),
    [transport?.prepare],
  );
  const control = usePublicationControls(
    realm.id,
    sendPublication,
    (input, target, head) => {
      publications.update((previous) => ({
        ...previous,
        items:
          input.action === 'publish'
            ? [{ ...target, publicationId: head }, ...previous.items.filter((subject) => subject.id !== target.id)]
            : previous.items.filter((subject) => subject.id !== target.id),
      }));
      if (!onCompleted || !current() || !control.current()) return;
      const intent = {};
      const draftCurrent = control.current;
      setCompleted({ input, head, intent, focus: commandFocus.current, current: () => current() && draftCurrent() });
      // Use the existing shelf reader and its admission receipt, including the selected physical window.
      if (selection.node === 'publications' && selection.cursor) void publications.restore(selection.cursor, intent);
      else void publications.load(true, intent);
    },
    publications.items,
    !frozen && state === 'signed-in' && Boolean(csrfToken),
    reader ?? '',
    preparePublication,
    realm,
  );
  useEffect(() => {
    const receipt = publications.continuation;
    if (
      !completed ||
      !completed.current() ||
      publications.busy ||
      publications.failure ||
      receipt?.intent !== completed.intent ||
      !receipt.current() ||
      delivered.current.has(completed.intent)
    )
      return;
    delivered.current.add(completed.intent);
    const receiptCurrent = () => completed.current() && receipt.current();
    const result: RealmPublicationCompletion = {
      realmId: realm.id,
      subjectId: completed.input.subjectId,
      action: completed.input.action,
      head: completed.head,
      current: receiptCurrent,
      focusEligible: () => receiptCurrent() && !!completed.focus?.eligible(),
    };
    const eligible = result.focusEligible();
    const handedOff = onCompleted?.(result) === true;
    if (eligible && !handedOff && result.current()) completed.focus?.restore(publicationFocus.boundaryRef.current);
    else completed.focus?.cancel();
  }, [completed, publications.continuation, publications.busy, publications.failure, onCompleted]);
  return (
    <>
      <Boards
        returnFor={(id) => returnFor('boards', id)}
        current={current}
        focus={boardFocus}
        boards={boardRestoring ? [] : boards.items}
        unavailable={boards.unavailable}
        complete={!boardRestoring && !boards.next && !boards.failure}
        continuation={
          <ShelfContinuation
            {...boards}
            busy={boards.busy || boardRestoring}
            label={m.realm_boards_more()}
            onContinue={boardFocus.activate}
            recoveryRef={boardFocus.recoveryRef}
          />
        }
      />
      <Published
        returnFor={(id) => returnFor('publications', id)}
        current={current}
        focus={publicationFocus}
        realm={{
          ...realm,
          published: publicationRestoring ? [] : publications.items,
          publicationNext: publications.next,
          unavailablePublished: publications.unavailable,
        }}
        control={control}
        onCommand={(event) => {
          commandFocus.current = captureFocus(event);
        }}
        editable={!frozen && !publicationRestoring && state === 'signed-in' && Boolean(csrfToken)}
        complete={!publicationRestoring && !publications.next && !publications.failure}
        refresh={() => publications.load(true)}
        search={search}
        continuation={
          <ShelfContinuation
            {...publications}
            busy={publications.busy || publicationRestoring}
            label={m.realm_publications_more()}
            onContinue={publicationFocus.activate}
            recoveryRef={publicationFocus.recoveryRef}
          />
        }
      />
    </>
  );
}

/** A changed actor or container discards private controllers before the new viewer can render them. */
export function SpacePage(props: {
  page: SpacePageData;
  realmManagement?: ReactNode;
  realmAppearance?: ReactNode;
  lifecycleAdapter?: ContainerLifecycleAdapter;
  realmClaimAdapter?: RealmClaimAdapter;
  nativeOperations?: NativeRealmHomeOperations;
}) {
  const { state, subject, csrfToken } = useSession();
  const location = useLocation();
  const locale = getLocale();
  const viewer = state === 'signed-in' && subject ? subject : null;
  const lifetime = useSpacePageLifetime();
  const retired = useRef(new WeakSet<SpacePageData>());
  const source = useRef({
    page: props.page,
    revision: 0,
    state,
    subject,
    csrfToken,
    locale,
    route: location.publicHref,
    operations: props.nativeOperations,
    binding: nativeHomeBinding(props.page),
  });
  if (source.current.page !== props.page) {
    retired.current.add(source.current.page);
    source.current = {
      page: props.page,
      revision: source.current.revision + 1,
      state,
      subject,
      csrfToken,
      locale,
      route: location.publicHref,
      operations: props.nativeOperations,
      binding: nativeHomeBinding(props.page),
    };
  }
  const native = props.page.realm?.nativeObservation;
  // A replacement credential/route cannot adopt the old native response, even with the same subject.
  if (
    (native || source.current.binding) &&
    (!sameNativeHomeBinding(source.current.binding, nativeHomeBinding(props.page)) ||
      source.current.state !== state ||
      source.current.subject !== subject ||
      source.current.csrfToken !== csrfToken ||
      source.current.locale !== locale ||
      source.current.route !== location.publicHref ||
      source.current.operations !== props.nativeOperations)
  )
    retired.current.add(props.page);
  if (
    (native || source.current.binding) &&
    (retired.current.has(props.page) || (lifetime && !lifetime.matchesPage(props.page)))
  )
    return null;
  return (
    <AuthoringDepartureBoundary>
      <SpaceHome
        key={`${props.page.space.id}:${props.page.realm?.id ?? ''}:${viewer ?? state}:${lifetime?.scopeKey ?? 'standalone'}:${source.current.revision}`}
        {...props}
        viewer={viewer}
        signedOut={state === 'signed-out'}
      />
    </AuthoringDepartureBoundary>
  );
}

function SpaceHome({
  page,
  realmManagement,
  realmAppearance,
  lifecycleAdapter,
  realmClaimAdapter,
  nativeOperations,
  viewer,
  signedOut,
}: Parameters<typeof SpacePage>[0] & { viewer: string | null; signedOut: boolean }) {
  const location = useLocation();
  const localizedHref = /^\/(en|zh-Hant|zh-Hans|ja|ko|fr|de|es)\//.test(location.publicHref)
    ? location.publicHref
    : `/${getLocale()}${location.publicHref}`;
  const initialReturn =
    realmReadingReturn(localizedHref, getLocale()) ??
    (page.realm ? `/${getLocale()}/realms/${page.realm.id}` : localizedHref.split(/[?#]/, 1)[0]!);
  const [readingReturn, setReadingReturn] = useState(initialReturn);
  const catalogueRevision = useRef(0);
  const catalogueVersion = catalogueRevision.current;
  const [spaceRestriction, restrictSpace] = useState<{ id: string; state: 'removed' | 'orphaned' } | null>(null);
  const [realmRestriction, restrictRealm] = useState<{ id: string; state: 'removed' | 'orphaned' } | null>(null);
  const [claim, setClaim] = useState<{
    realmId: string;
    read: RealmClaimRead;
    pageSource: RealmClaimSnapshot | null | undefined;
  } | null>(null);
  const realmId = page.realm?.id;
  const nativeObservation = page.realm?.nativeObservation;
  const locale = getLocale();
  const nativeShelves = useMemo(
    () =>
      nativeOperations && page.realm
        ? nativeRealmHomeShelves(nativeOperations, {
            realmId: page.realm.id,
            languages: requestLanguages(locale),
          })
        : null,
    [nativeOperations, page.realm?.id, locale],
  );
  const nativeShelfTransport = useMemo<RealmShelfTransport | undefined>(
    () => (nativeShelves ? { ...nativeShelves, change: async () => ({ kind: 'denied' }) } : undefined),
    [nativeShelves],
  );
  const pageSource = page.realm?.continuity;
  const claimRead = claim?.realmId === realmId && claim?.pageSource === pageSource ? claim?.read : null;
  const onClaimRead = useCallback(
    (read: RealmClaimRead) => {
      catalogueRevision.current++;
      if (realmId) setClaim({ realmId, read, pageSource });
      if (read.kind === 'ready' && read.snapshot.ownershipState === 'owned') {
        restrictRealm((previous) => (previous?.state === 'orphaned' && previous.id === realmId ? null : previous));
      }
    },
    [realmId, pageSource],
  );
  const onRealmRestriction = useCallback(
    (state: 'removed' | 'orphaned') => {
      catalogueRevision.current++;
      if (!realmId) return;
      setReadingReturn(`/${getLocale()}/realms/${realmId}`);
      restrictRealm((previous) =>
        previous?.id === realmId && previous.state === state ? previous : { id: realmId, state },
      );
    },
    [realmId],
  );
  const spaceRemoved = spaceRestriction?.id === page.space.id && spaceRestriction.state === 'removed';
  const realmRestricted = realmRestriction?.id === page.realm?.id ? realmRestriction?.state : null;
  const realmRemoved = spaceRemoved || realmRestricted === 'removed';
  const readable = claimRead?.kind !== 'denied' && claimRead?.kind !== 'closed';
  const frozen =
    nativeObservation?.viewer.state === 'orphaned' ||
    realmRestricted === 'orphaned' ||
    (claimRead
      ? claimRead.kind !== 'ready' || claimRead.snapshot.governanceReadOnly
      : page.realm?.continuity?.governanceReadOnly === true);
  const [entered, setEntered] = useState(false);
  const managementId = useId();
  const [admissions, setAdmissions] = useState<Partial<Record<CommunityManagementOperation, boolean>>>({});
  const report = useCallback((operation: CommunityManagementOperation, admitted: boolean) => {
    setAdmissions((previous) => (previous[operation] === admitted ? previous : { ...previous, [operation]: admitted }));
  }, []);
  const management = useMemo(() => ({ entered, report }), [entered, report]);
  const setup = useSpaceSetupRead(page.space.id);
  const orphaned =
    nativeObservation?.viewer.state === 'orphaned' ||
    realmRestricted === 'orphaned' ||
    (claimRead?.kind === 'ready'
      ? claimRead.snapshot.ownershipState === 'orphaned'
      : pageSource?.ownershipState === 'orphaned');
  const managementRestricted = realmRemoved || orphaned || !readable;
  const setupAdmitted =
    !managementRestricted && setup?.kind === 'ready' && Object.values(setup.permitted).some(Boolean);
  const nativeManageAdmitted = nativeObservation?.actions.manage === 'admitted' && !orphaned;
  const admitted =
    viewer !== null &&
    (nativeObservation
      ? nativeManageAdmitted
      : setupAdmitted ||
        admissions['space-lifecycle'] ||
        (!orphaned && admissions['realm-lifecycle']) ||
        (!managementRestricted && (admissions.appearance || admissions.bans)));
  const presentationCurrent =
    !realmRemoved &&
    readable &&
    (realmRestricted !== 'orphaned' || pageSource?.governanceReadOnly === true) &&
    (!claimRead ||
      (claimRead.kind === 'ready' && !!pageSource && sameRealmClaimSource(pageSource, claimRead.snapshot)));
  const showCommunity = presentationCurrent && page.realm && page.realm.presentation?.state !== 'hidden';
  const participation = !spaceRemoved ? (
    <section aria-label={m.space_follow_label()} className="flex flex-wrap items-start gap-3">
      {signedOut ? (
        <Button
          nativeButton={false}
          variant="outline"
          render={<a href={`/auth/sign-in?return_to=${encodeURIComponent(readingReturn)}`} />}
        >
          {m.library_follow()}
        </Button>
      ) : (
        <FollowTargetControl targetId={page.space.id} />
      )}
      {page.realm && !realmRemoved && (nativeObservation ? true : readable && !frozen) ? (
        <RealmMembership
          realm={page.realm}
          spaceId={page.space.id}
          returnTo={readingReturn}
          {...(nativeObservation ? { nativeObservation } : {})}
        />
      ) : null}
    </section>
  ) : null;
  const colors = placeholderColors({ id: page.space.id, types: [] });
  const banner = page.space.banner;
  const bannerVariant = banner?.variants.find((variant) => variant.format === 'webp') ?? banner?.variants.at(-1);
  const previewSrc =
    banner && 'previewSrc' in banner && typeof banner.previewSrc === 'string' ? banner.previewSrc : null;
  const bannerSrc =
    previewSrc ??
    (banner && bannerVariant ? coverSrc(banner.media, bannerVariant.format, bannerVariant.width) : undefined);
  return (
    <article
      className="max-w-5xl space-y-10 text-foreground"
      {...(page.realmCarrier ? { 'data-realm-carrier': page.realmCarrier } : {})}
    >
      {page.realmCarrier === 'unavailable' ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.realm_shelf_unavailable()}
        </p>
      ) : null}
      {showCommunity && page.realm ? (
        <RealmHomeHeader realm={page.realm} space={page.space} participation={participation} />
      ) : (
        <>
          <header
            className="relative isolate flex flex-col gap-4 overflow-hidden rounded-3xl px-6 py-8 sm:px-10 sm:py-10"
            style={{ backgroundColor: colors.background, color: colors.foreground }}
          >
            {bannerSrc && !spaceRemoved ? (
              <>
                <img
                  src={bannerSrc}
                  alt=""
                  aria-hidden="true"
                  className="absolute inset-0 -z-20 h-full w-full object-cover"
                  onError={(event) => {
                    event.currentTarget.style.display = 'none';
                  }}
                />
                <div aria-hidden="true" className="absolute inset-0 -z-10 bg-black/75" />
              </>
            ) : null}
            <div className="relative z-10 flex w-full flex-wrap items-center justify-between gap-4">
              <PageHeading className="min-w-0 flex-1 basis-64">{page.space.title}</PageHeading>
            </div>
            {page.space.summary && !spaceRemoved ? (
              <p className="relative z-10 max-w-2xl text-lg/relaxed whitespace-pre-wrap">{page.space.summary}</p>
            ) : null}
          </header>
          {participation}
        </>
      )}
      {spaceRemoved || realmRemoved || orphaned ? (
        <p role="status" className="rounded-xl border p-4 text-sm">
          {spaceRemoved || realmRemoved ? m.container_lifecycle_removed_state() : m.container_lifecycle_orphaned()}
        </p>
      ) : null}
      <RealmCatalogueCurrent
        page={page}
        available={Boolean(page.realm && !realmRemoved && !orphaned && presentationCurrent)}
        sourceRevision={catalogueVersion}
        isCurrentSource={() => catalogueRevision.current === catalogueVersion}
      />
      {page.realm && !realmRemoved && readable ? (
        <RealmShelf
          key={page.realm.id}
          realm={page.realm}
          frozen={frozen}
          returnTo={initialReturn}
          onReadingChange={setReadingReturn}
          {...(nativeShelfTransport ? { transport: nativeShelfTransport } : {})}
        />
      ) : null}
      {page.realm && !realmRemoved && (!nativeObservation || nativeObservation.actions.claim === 'admitted') ? (
        <RealmClaimPanel
          realmId={page.realm.id}
          initial={page.realm.continuity ?? null}
          returnTo={readingReturn}
          onRead={onClaimRead}
          {...(realmClaimAdapter ? { adapter: realmClaimAdapter } : {})}
        />
      ) : null}
      {admitted ? (
        <Button
          variant="outline"
          aria-expanded={entered}
          aria-controls={managementId}
          onClick={() => setEntered((previous) => !previous)}
        >
          {m.community_manage()}
        </Button>
      ) : null}
      <CommunityManagementContext.Provider value={management}>
        <div id={managementId} hidden={!entered} inert={!entered} className="min-w-0 space-y-8">
          {entered ? (
            <header className="flex flex-wrap items-center justify-between gap-3 border-t pt-6">
              <h2 className="text-2xl font-semibold">{m.community_manage()}</h2>
              <Button variant="ghost" onClick={() => setEntered(false)}>
                {m.community_manage_close()}
              </Button>
            </header>
          ) : null}
          {entered && setupAdmitted ? <SpaceSetupEntry spaceId={page.space.id} read={setup} /> : null}
          {entered && !managementRestricted ? (
            <ResourceAccessLink resourceId={page.realm?.id ?? page.space.id} />
          ) : null}
          {entered && !managementRestricted && page.realm ? (
            <Link
              to="/realms/$id/questions"
              params={{ id: page.realm.id }}
              className="inline-flex rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted focus-visible:outline focus-visible:outline-2"
            >
              {m.realm_question_management_link()}
            </Link>
          ) : null}
          {entered && !managementRestricted && page.realm ? (
            <RealmMembersEntry realmId={page.realm.id} appearance={admissions.appearance === true} setup={setup} />
          ) : null}
          {viewer && page.realm && (!nativeObservation || (entered && nativeManageAdmitted)) ? (
            <div hidden={managementRestricted} inert={managementRestricted} className="min-w-0 space-y-8">
              {realmAppearance ?? <RealmAppearancePanel realmId={page.realm.id} />}
              {realmManagement ?? <RealmBansPanel realmId={page.realm.id} />}
            </div>
          ) : null}
          <ContainerLifecyclePanel
            key={`space:${page.space.id}`}
            target={{ kind: 'space', id: page.space.id }}
            title={page.space.title}
            {...(lifecycleAdapter ? { adapter: lifecycleAdapter } : {})}
            onRestriction={(state) => {
              catalogueRevision.current++;
              setReadingReturn(localizedHref.split(/[?#]/, 1)[0]!);
              restrictSpace((previous) =>
                previous?.id === page.space.id && previous.state === state ? previous : { id: page.space.id, state },
              );
            }}
          />
          {page.realm ? (
            <ContainerLifecyclePanel
              key={`realm:${page.realm.id}`}
              target={{ kind: 'realm', id: page.realm.id }}
              title={page.realm.title}
              {...(lifecycleAdapter ? { adapter: lifecycleAdapter } : {})}
              onRestriction={onRealmRestriction}
            />
          ) : null}
        </div>
      </CommunityManagementContext.Provider>
    </article>
  );
}
