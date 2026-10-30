import { ResourceAccessLink } from '../accounts/resource-access/link';
import { useCallback, useState, type ReactNode } from 'react';
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
import type { PublishedSubject, RealmBoard, RealmHome, SpacePageData } from './space';
import { SpaceSetupEntry } from './space-setup-page';
import { FollowTargetControl } from '../library/follow-target-control';
import { useSession } from '../session/query';
import { useShelfList } from './space-queries';
import { changeRealmPublication, readRealmBoards, readRealmPublications } from './space-actions';
import {
  PublicationControls,
  ShelfContinuation,
  usePublicationControls,
  type PublicationSend,
} from './publication-controls-view';
import type { ShelfPage } from './space';
import type { ReadCredentialMode } from '../kernel/credential';
import { ContainerLifecyclePanel } from './container-lifecycle-controls';
import type { ContainerLifecycleAdapter } from './container-lifecycle';
import { RealmAppearancePanel } from './realm-presentation-panel';
import { RealmClaimPanel } from './realm-claim-panel';
import type { RealmClaimAdapter, RealmClaimRead, RealmClaimSnapshot } from './realm-claim';

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
}: {
  boards: RealmBoard[];
  unavailable: number;
  continuation: React.ReactNode;
  complete: boolean;
}) {
  return (
    <section className="space-y-4" aria-labelledby="realm-boards-heading">
      <h2 id="realm-boards-heading" className="text-xl font-semibold">
        {m.realm_boards_heading()}
      </h2>
      {boards.length ? (
        <ul className="space-y-1">
          {boards.map((board) => (
            <ListRow key={board.id} className="flex items-start gap-4 rounded-xl px-4 py-3">
              <Link
                to="/boards/$id"
                params={{ id: board.id }}
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
    </section>
  );
}

function CarriedRealm({ realm }: { realm: RealmHome }) {
  return (
    <section className="space-y-4" aria-labelledby="space-realm-heading">
      <h2 id="space-realm-heading" className="text-xl font-semibold">
        {m.space_realm_heading()}
      </h2>
      <ul className="space-y-1">
        <ListRow className="flex items-start gap-4 rounded-xl px-4 py-3">
          <Link
            to="/realms/$id"
            params={{ id: realm.id }}
            data-slot="list-row-link"
            className="absolute inset-1 z-0 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <span className="sr-only">{realm.title}</span>
          </Link>
          <div className="min-w-0 flex-1 space-y-1">
            <h3 className="font-semibold">{realm.title}</h3>
            {realm.summary ? <p className="text-sm leading-relaxed text-muted-foreground">{realm.summary}</p> : null}
          </div>
        </ListRow>
      </ul>
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
}: {
  realm: RealmHome;
  control: ReturnType<typeof usePublicationControls>;
  editable: boolean;
  continuation: React.ReactNode;
  complete: boolean;
  refresh: () => Promise<void>;
}) {
  const locale = getLocale();
  const titled: { subject: PublishedSubject; cover: CoverSubject }[] = realm.published.map((subject) => ({
    subject,
    cover: { id: subject.id, title: subjectTitle(subject, locale), types: subject.types },
  }));
  const ratio = sharedRatio(titled.map((item) => item.cover));
  return (
    <section className="space-y-4" aria-labelledby="realm-published-heading">
      <h2 id="realm-published-heading" className="text-xl font-semibold">
        {m.realm_published_heading()}
      </h2>
      <p className="text-sm text-muted-foreground">{m.realm_publication_global_fallback()}</p>
      {editable ? <PublicationControls control={control} refresh={refresh} /> : null}
      {titled.length ? (
        <CoverRow ratio={ratio} label={`${m.realm_published_heading()} (${titled.length})`}>
          {titled.map(({ subject, cover }) => (
            <CoverCard
              key={subject.id}
              href={subjectHref({ id: subject.id, label: subjectTitle(subject, locale) }, locale).href}
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
                        onSelect: () => void control.change('withdraw', { ...subject, title: cover.title }),
                      },
                      {
                        type: 'destructive' as const,
                        label: m.realm_publication_reject(),
                        disabled: control.locked || !subject.publicationId,
                        onSelect: () => void control.change('reject', { ...subject, title: cover.title }),
                      },
                    ],
                  }
                : {})}
            />
          ))}
        </CoverRow>
      ) : null}
      {(realm.unavailablePublished ?? 0) > 0 ? (
        <p className="text-muted-foreground">{m.realm_published_unavailable()}</p>
      ) : !titled.length && complete ? (
        <p className="text-muted-foreground">{m.realm_published_empty()}</p>
      ) : null}
      {continuation}
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
};

/** One reusable shelf region; its stories exercise the same controls used on Space and Realm pages. */
export function RealmShelf({
  realm,
  transport,
  frozen = false,
}: {
  realm: RealmHome;
  transport?: RealmShelfTransport;
  frozen?: boolean;
}) {
  const { state, csrfToken } = useSession();
  const boards = useShelfList(
    {
      items: realm.boards,
      next: realm.boardNext ?? null,
      unavailable: realm.unavailableBoards ?? 0,
      credentialMode: realm.credentialMode ?? 'anonymous',
    },
    transport?.boards ?? ((input) => readRealmBoards({ data: { realmId: realm.id, ...input } })),
  );
  const publications = useShelfList(
    {
      items: realm.published,
      next: realm.publicationNext ?? null,
      unavailable: realm.unavailablePublished ?? 0,
      credentialMode: realm.credentialMode ?? 'anonymous',
    },
    transport?.publications ?? ((input) => readRealmPublications({ data: { realmId: realm.id, ...input } })),
  );
  const control = usePublicationControls(
    realm.id,
    transport?.change ??
      ((input) =>
        csrfToken
          ? changeRealmPublication({ data: input, headers: { 'X-CSRF-Token': csrfToken } })
          : Promise.resolve({ kind: 'denied' })),
    (input, target, head) =>
      publications.update((previous) => ({
        ...previous,
        items:
          input.action === 'publish'
            ? [{ ...target, publicationId: head }, ...previous.items.filter((subject) => subject.id !== target.id)]
            : previous.items.filter((subject) => subject.id !== target.id),
      })),
    publications.items,
  );
  return (
    <>
      <Boards
        boards={boards.items}
        unavailable={boards.unavailable}
        complete={!boards.next && !boards.failure}
        continuation={<ShelfContinuation {...boards} label={m.realm_boards_more()} />}
      />
      <Published
        realm={{
          ...realm,
          published: publications.items,
          publicationNext: publications.next,
          unavailablePublished: publications.unavailable,
        }}
        control={control}
        editable={!frozen && state === 'signed-in' && Boolean(csrfToken)}
        complete={!publications.next && !publications.failure}
        refresh={() => publications.load(true)}
        continuation={<ShelfContinuation {...publications} label={m.realm_publications_more()} />}
      />
    </>
  );
}

function Home({
  realm,
  management,
  claim,
  frozen,
  readable,
}: {
  realm: RealmHome;
  management: ReactNode;
  claim: ReactNode;
  frozen: boolean;
  readable: boolean;
}) {
  return (
    <>
      {readable ? <CarriedRealm realm={realm} /> : null}
      {readable ? <RealmShelf key={realm.id} realm={realm} frozen={frozen} /> : null}
      {claim}
      {frozen || !readable ? null : management}
    </>
  );
}

/** A Space's page: its title and summary as the brand surface, and the Realm it carries as that Realm's home. */
export function SpacePage({
  page,
  realmManagement,
  realmAppearance,
  lifecycleAdapter,
  realmClaimAdapter,
}: {
  page: SpacePageData;
  realmManagement?: ReactNode;
  realmAppearance?: ReactNode;
  lifecycleAdapter?: ContainerLifecycleAdapter;
  realmClaimAdapter?: RealmClaimAdapter;
}) {
  const location = useLocation();
  const [spaceRestriction, restrictSpace] = useState<{ id: string; state: 'removed' | 'orphaned' } | null>(null);
  const [realmRestriction, restrictRealm] = useState<{ id: string; state: 'removed' | 'orphaned' } | null>(null);
  const [claim, setClaim] = useState<{
    realmId: string;
    read: RealmClaimRead;
    pageSource: RealmClaimSnapshot | null | undefined;
  } | null>(null);
  const realmId = page.realm?.id;
  const pageSource = page.realm?.continuity;
  const claimRead = claim?.realmId === realmId && claim?.pageSource === pageSource ? claim?.read : null;
  const onClaimRead = useCallback(
    (read: RealmClaimRead) => {
      if (realmId) setClaim({ realmId, read, pageSource });
      if (read.kind === 'ready' && read.snapshot.ownershipState === 'owned') {
        restrictRealm((previous) =>
          previous?.state === 'orphaned' && previous.id === realmId ? null : previous,
        );
      }
    },
    [realmId, pageSource],
  );
  const onRealmRestriction = useCallback(
    (state: 'removed' | 'orphaned') => {
      if (!realmId) return;
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
    realmRestricted === 'orphaned' ||
    (claimRead
      ? claimRead.kind !== 'ready' || claimRead.snapshot.governanceReadOnly
      : page.realm?.continuity?.governanceReadOnly === true);
  const colors = placeholderColors({ id: page.space.id, types: [] });
  const banner = page.space.banner;
  const bannerVariant = banner?.variants.find((variant) => variant.format === 'webp') ?? banner?.variants.at(-1);
  const previewSrc =
    banner && 'previewSrc' in banner && typeof banner.previewSrc === 'string' ? banner.previewSrc : null;
  const bannerSrc =
    previewSrc ??
    (banner && bannerVariant ? coverSrc(banner.media, bannerVariant.format, bannerVariant.width) : undefined);
  return (
    <article className="max-w-5xl space-y-10 text-foreground">
      <header
        className="relative isolate flex flex-col gap-4 overflow-hidden rounded-3xl px-6 py-8 sm:px-10 sm:py-10"
        style={{ backgroundColor: banner?.placeholder.color ?? colors.background, color: colors.foreground }}
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
            <div
              aria-hidden="true"
              className="absolute inset-0 -z-10 bg-gradient-to-r from-black/75 via-black/50 to-black/15"
            />
          </>
        ) : null}
        <div className="relative z-10 flex w-full flex-wrap items-center justify-between gap-4">
          <PageHeading className="min-w-0 flex-1 basis-64">{page.space.title}</PageHeading>
          {page.realm && !realmRemoved && readable ? (
            <div className="shrink-0">
              <RealmMembership
                realm={page.realm}
                spaceId={page.space.id}
                returnTo={location.publicHref.split(/[?#]/, 1)[0]!}
              />
            </div>
          ) : null}
        </div>
        {page.space.summary && !spaceRemoved ? (
          <p className="relative z-10 max-w-2xl text-lg/relaxed whitespace-pre-wrap">{page.space.summary}</p>
        ) : null}
      </header>
      {!realmRemoved && !frozen ? <SpaceSetupEntry spaceId={page.space.id} /> : null}
      {!spaceRemoved ? (
        <>
          <section aria-label={m.space_follow_label()}>
            <FollowTargetControl targetId={page.space.id} />
            {!realmRemoved && readable && !frozen ? (
              <ResourceAccessLink resourceId={page.realm?.id ?? page.space.id} />
            ) : null}
          </section>
        </>
      ) : null}
      {page.realm && !realmRemoved ? (
        <Home
          realm={page.realm}
          frozen={frozen}
          readable={readable}
          claim={
            <RealmClaimPanel
              realmId={page.realm.id}
              initial={page.realm.continuity ?? null}
              returnTo={location.publicHref.split(/[?#]/, 1)[0]!}
              onRead={onClaimRead}
              {...(realmClaimAdapter ? { adapter: realmClaimAdapter } : {})}
            />
          }
          management={
            <>
              {realmAppearance ?? <RealmAppearancePanel realmId={page.realm.id} />}
              {realmManagement ?? <RealmBansPanel realmId={page.realm.id} />}
            </>
          }
        />
      ) : null}
      <ContainerLifecyclePanel
        key={`space:${page.space.id}`}
        target={{ kind: 'space', id: page.space.id }}
        title={page.space.title}
        {...(lifecycleAdapter ? { adapter: lifecycleAdapter } : {})}
        onRestriction={(state) =>
          restrictSpace((previous) =>
            previous?.id === page.space.id && previous.state === state ? previous : { id: page.space.id, state },
          )
        }
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
    </article>
  );
}
