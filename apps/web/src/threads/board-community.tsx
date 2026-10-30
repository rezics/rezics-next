import type { ReactNode } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@rezics/ui/shadcn/avatar';
import { Badge } from '@rezics/ui/shadcn/badge';
import { Button } from '@rezics/ui/shadcn/button';
import { DocumentBody } from '../document-body';
import { MediaImage } from '@rezics/ui/media-image';
import { Menu } from '@rezics/ui/menu';
import { EllipsisIcon } from 'lucide-react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { coverSrc } from '../media/cover-src';
import { BoardContext } from './thread-context';
import { BoardFeed } from './board-feed';
import type { CommunityBoardPage } from './board-feed-data';
import type { RealmPresentationImage } from './board-community-source';
import type { BoardSort } from './board-sort';
import { initials } from './initials';

/** One owned community region, reused by the actual route and Patterns. The shell owns surrounding navigation. */
export function BoardCommunity({
  page,
  sort,
  participation,
  start,
  overflow,
}: {
  page: CommunityBoardPage;
  sort: BoardSort;
  participation?: ReactNode;
  start?: ReactNode;
  overflow?: ReactNode;
}) {
  const { board, realm, threads, authors, now } = page;
  const title = board.title ?? m.threads_untitled();
  const community = page.community?.state === 'available' ? page.community.value : null;
  const name = community?.name ?? realm?.title ?? title;
  // An authored empty summary must not fall back to another container's description.
  const summary = community ? community.description : realm?.summary;
  const avatar = community?.avatar.state === 'available' ? community.avatar.value : null;
  const banner = community?.banner.state === 'available' ? community.banner.value : null;
  const avatarVariant =
    avatar?.variants.find((variant) => variant.format === 'webp' && variant.width >= 96) ?? avatar?.variants[0];
  const rules = community?.rules;
  const contextRealm = community ? { id: community.realmId, title: community.name } : realm;
  return (
    <article className="w-full min-w-0 max-w-6xl space-y-6 text-foreground" data-slot="board-community">
      <header className="overflow-hidden rounded-3xl bg-card">
        {banner ? (
          <MediaImage
            media={banner.id}
            width={banner.width}
            height={banner.height}
            variants={banner.variants}
            placeholder={banner.placeholder}
            src={({ media, format, width }) => coverSrc(media, format, width)}
            alt=""
            sizes="(min-width: 1280px) 1152px, 100vw"
            frame={6}
            priority
            className="h-24 rounded-none sm:h-36 [&_img]:[object-position:inherit]"
            style={{ objectPosition: imagePosition(banner) }}
          />
        ) : (
          <div aria-hidden="true" data-slot="board-banner-fallback" className="aura-surface h-24 sm:h-36" />
        )}
        <div className="space-y-4 px-4 pb-5 sm:px-6 sm:pb-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <Avatar className="-mt-9 size-20 border-4 border-card text-2xl sm:size-24">
              {avatar && avatarVariant ? (
                <AvatarImage
                  src={coverSrc(avatar.id, avatarVariant.format, avatarVariant.width)}
                  alt=""
                  style={{ objectPosition: imagePosition(avatar) }}
                />
              ) : null}
              <AvatarFallback className="text-2xl sm:text-3xl">{initials(name)}</AvatarFallback>
            </Avatar>
            <div className="flex max-w-full flex-wrap items-center gap-2 pt-3">
              {participation}
              {overflow ?? <BoardCommunityMenu boardId={board.id} />}
            </div>
          </div>
          <BoardContext realm={contextRealm} />
          <PageHeading className="break-words text-2xl sm:text-3xl">{title}</PageHeading>
          {summary ? <p className="line-clamp-1 max-w-3xl text-muted-foreground">{summary}</p> : null}
          {board.realmId !== null ? (
            <p className="text-sm text-muted-foreground" data-slot="board-community-members">
              {community?.members.state === 'current'
                ? m.board_community_members({ count: community.members.count })
                : m.board_community_members_unknown()}
            </p>
          ) : null}
          {board.visibility === 'protected' ? <Badge variant="secondary">{m.board_community_protected()}</Badge> : null}
        </div>
      </header>
      <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <BoardFeed boardId={board.id} sort={sort} page={threads} authors={authors} now={now} actions={start} />
        <aside className="space-y-4 rounded-2xl bg-card p-5" aria-labelledby="board-about-heading">
          <h2 id="board-about-heading" className="font-semibold">
            {m.board_community_about()}
          </h2>
          {summary ? <p className="text-sm leading-relaxed text-muted-foreground">{summary}</p> : null}
          {board.realmId === null ? (
            <p className="text-sm leading-relaxed text-muted-foreground">{m.board_community_global()}</p>
          ) : null}
          {board.realmId !== null && !community && !realm ? (
            <p role="status" className="text-sm text-muted-foreground">
              {m.board_community_source_unavailable()}
            </p>
          ) : null}
          {contextRealm ? (
            <a
              href={`/${getLocale()}/realms/${contextRealm.id}`}
              className="inline-flex min-h-11 items-center text-sm font-medium text-primary hover:underline"
            >
              {contextRealm.title}
            </a>
          ) : null}
          {board.visibility === 'protected' ? (
            <p className="text-sm text-muted-foreground">{m.board_community_protected_help()}</p>
          ) : null}
          {board.realmId !== null ? (
            <section className="space-y-3 border-t border-border pt-4" aria-labelledby="board-rules-heading">
              <h3 id="board-rules-heading" className="font-semibold">
                {m.board_community_rules()}
              </h3>
              {rules?.state === 'available' ? (
                <>
                  <DocumentBody document={rules.value.body} locale={getLocale()} className="text-sm" />
                  <a
                    href={`/${getLocale()}/posts/${rules.value.postId}/revisions/${rules.value.revisionId}`}
                    className="inline-flex min-h-11 items-center text-sm text-primary hover:underline"
                  >
                    {m.board_community_rules_revision()}
                  </a>
                  <p className="text-xs text-muted-foreground">{rules.value.licence}</p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {rules?.state === 'none' ? m.board_community_rules_none() : m.board_community_rules_unavailable()}
                </p>
              )}
            </section>
          ) : null}
          {avatar?.credit ? <ImageCredit image={avatar} /> : null}
          {banner?.credit ? <ImageCredit image={banner} /> : null}
        </aside>
      </div>
    </article>
  );
}

function imagePosition(image: RealmPresentationImage): string | undefined {
  return image.focalPoint ? `${image.focalPoint.x * 100}% ${image.focalPoint.y * 100}%` : undefined;
}

function ImageCredit({ image }: { image: RealmPresentationImage }) {
  const credit = image.credit;
  if (!credit) return null;
  return (
    <p className="text-xs text-muted-foreground">
      © {credit.rightsHolder} ·{' '}
      <a href={credit.via.url} rel="noopener noreferrer nofollow" className="underline">
        {credit.via.name}
      </a>{' '}
      · {credit.license}
    </p>
  );
}

export function BoardCommunityMenu({ boardId, signedIn = false }: { boardId: string; signedIn?: boolean }) {
  return (
    <Menu
      title={m.board_more_actions()}
      trigger={
        <Button variant="ghost" size="icon" aria-label={m.board_more_actions()}>
          <EllipsisIcon />
        </Button>
      }
      entries={[
        { type: 'link', label: m.board_threads_heading(), href: `/${getLocale()}/boards/${boardId}` },
        ...(signedIn
          ? [
              {
                type: 'link' as const,
                label: m.moderation_reports_heading(),
                href: `/${getLocale()}/boards/${boardId}/moderation`,
              },
            ]
          : []),
      ]}
    />
  );
}

/** Route preparation and failures share the same content width; they never render fabricated feed rows. */
export function BoardCommunityStatus({
  state,
  onRetry,
}: {
  state: 'loading' | 'error' | 'closed';
  onRetry?: () => void;
}) {
  return (
    <section className="w-full max-w-6xl rounded-3xl bg-card p-6 sm:p-10" aria-busy={state === 'loading'}>
      <PageHeading>
        {state === 'closed'
          ? m.platform_closed_heading()
          : state === 'loading'
            ? m.board_threads_heading()
            : m.error_heading()}
      </PageHeading>
      <p role="status" className="mt-4 text-muted-foreground">
        {state === 'closed'
          ? m.platform_closed_message()
          : state === 'loading'
            ? m.board_community_loading()
            : m.error_message()}
      </p>
      {state === 'error' && onRetry ? (
        <Button variant="outline" className="mt-4" onClick={onRetry}>
          {m.board_community_retry()}
        </Button>
      ) : null}
    </section>
  );
}
