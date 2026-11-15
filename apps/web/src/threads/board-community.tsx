import { useId, useState, type ReactNode } from 'react';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import {
  CommunityBanner,
  CommunityAvatar,
  CommunityMemberCount,
  CommunityRules,
  ImageCredit,
} from '../community/community-presentation-parts';
import { Badge } from '@rezics/ui/shadcn/badge';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Menu } from '@rezics/ui/menu';
import { EllipsisIcon } from 'lucide-react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { BoardContext } from './thread-context';
import { BoardFeed } from './board-feed';
import type { BoardOpeningReactionOrigin } from './board-opening';
import type { CommunityBoardPage } from './board-feed-data';
import type { BoardSort } from './board-sort';
import { boardRequestHref } from './board-navigation';
import type { BoardPreparedNavigation } from './board-navigation';

const actionControlLayout =
  '[&_a]:max-w-full [&_a]:whitespace-normal [&_button]:max-w-full [&_button]:whitespace-normal [&_svg]:shrink-0';

function BoardCommunityAboutBody({
  page,
  postingInterval,
}: {
  page: CommunityBoardPage;
  postingInterval?: ReactNode;
}) {
  const rulesHeadingId = useId();
  const { board } = page;
  const community = page.community?.state === 'available' ? page.community.value : null;
  const summary = community?.description;
  const rules = community?.rules;
  const avatar = community?.avatar.state === 'available' ? community.avatar.value : null;
  const banner = community?.banner.state === 'available' ? community.banner.value : null;
  const contextRealm = community ? { id: community.realmId, title: community.name } : undefined;

  return (
    <>
      {summary ? <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{summary}</p> : null}
      {board.realmId === null ? (
        <p className="text-sm leading-relaxed text-muted-foreground">{m.board_community_global()}</p>
      ) : null}
      {board.realmId !== null && !community ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.board_community_source_unavailable()}
        </p>
      ) : null}
      {contextRealm ? (
        <a
          href={`/${getLocale()}/realms/${contextRealm.id}`}
          className="inline-flex max-w-full items-center break-words text-sm font-medium text-primary hover:underline"
        >
          {contextRealm.title}
        </a>
      ) : null}
      {board.visibility === 'protected' ? (
        <p className="text-sm text-muted-foreground">{m.board_community_protected_help()}</p>
      ) : null}
      {board.realmId !== null ? (
        <section className="min-w-0 space-y-3 border-t border-border pt-5" aria-labelledby={rulesHeadingId}>
          <ContentItemHeading level={3} id={rulesHeadingId} className="text-base leading-snug font-semibold">
            {m.board_community_rules()}
          </ContentItemHeading>
          <CommunityRules rules={rules} />
        </section>
      ) : null}
      {postingInterval}
      {avatar?.credit ? <ImageCredit image={avatar} /> : null}
      {banner?.credit ? <ImageCredit image={banner} /> : null}
    </>
  );
}

/** One owned community region, reused by the actual route and Patterns. The shell owns surrounding navigation. */
export function BoardCommunity({
  page: initialPage,
  sort,
  cursor,
  participation,
  start,
  watch,
  overflow,
  postingInterval,
  reactionOrigin,
  navigation,
}: {
  page: CommunityBoardPage;
  sort: BoardSort;
  cursor?: string;
  participation?: ReactNode | ((page: CommunityBoardPage) => ReactNode);
  start?: ReactNode | ((page: CommunityBoardPage) => ReactNode);
  watch?: ReactNode;
  overflow?: ReactNode;
  postingInterval?: ReactNode;
  reactionOrigin?: BoardOpeningReactionOrigin;
  navigation?: BoardPreparedNavigation;
}) {
  const [replacement, setReplacement] = useState<{
    source: CommunityBoardPage;
    page: CommunityBoardPage;
    generation: number;
  } | null>(null);
  if (replacement && replacement.source !== initialPage) setReplacement(null);
  const page = replacement?.source === initialPage ? replacement.page : initialPage;
  const aboutHeadingId = useId();
  const { board, threads, authors, now } = page;
  const title = board.title ?? m.threads_untitled();
  const community = page.community?.state === 'available' ? page.community.value : null;
  const name = community?.name ?? title;
  // An authored empty summary must not fall back to another container's description.
  const summary = community?.description;
  const avatar = community?.avatar.state === 'available' ? community.avatar.value : null;
  const banner = community?.banner.state === 'available' ? community.banner.value : null;
  const contextRealm = community ? { id: community.realmId, title: community.name } : undefined;
  const startAction = typeof start === 'function' ? start(page) : start;
  const participationAction = typeof participation === 'function' ? participation(page) : participation;
  const overflowAction = overflow ?? <BoardCommunityMenu boardId={board.id} />;
  return (
    <article className="w-full min-w-0 max-w-6xl space-y-5 text-foreground" data-slot="board-community">
      <header className="overflow-hidden rounded-3xl bg-card">
        <CommunityBanner banner={banner} realmId={community?.realmId ?? board.realmId} />
        <div className="space-y-5 px-4 pb-5 pt-4 sm:px-6 sm:pb-6">
          <div className="flex min-w-0 flex-col gap-5 md:flex-row md:items-start md:justify-between">
            <div className="flex min-w-0 items-start gap-4">
              <div className="shrink-0 pt-1">
                <CommunityAvatar avatar={avatar} name={name} realmId={community?.realmId ?? board.realmId} />
              </div>
              <div className="min-w-0 flex-1 space-y-2 [overflow-wrap:anywhere]">
                <BoardContext realm={contextRealm} />
                <PageHeading className="break-words text-2xl sm:text-3xl [overflow-wrap:anywhere]">{title}</PageHeading>
                {summary ? (
                  <p className="line-clamp-3 max-w-3xl whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground sm:text-base">
                    {summary}
                  </p>
                ) : null}
                <div className="flex min-w-0 flex-wrap items-center gap-2 pt-1">
                  {board.realmId !== null ? (
                    <div data-slot="board-community-members">
                      <CommunityMemberCount members={community?.members} />
                    </div>
                  ) : null}
                  {board.visibility === 'protected' ? (
                    <Badge variant="secondary">{m.board_community_protected()}</Badge>
                  ) : null}
                </div>
              </div>
            </div>
            <div data-slot="board-community-actions" className="flex min-w-0 flex-col gap-3 md:w-56 md:shrink-0 md:items-end">
              {startAction ? (
                <div data-slot="board-community-start" className={`flex min-w-0 max-w-full flex-wrap items-center gap-2 md:justify-end ${actionControlLayout}`}>
                  {startAction}
                </div>
              ) : null}
              <div
                data-slot="board-community-participation"
                className={`flex min-w-0 max-w-full flex-wrap items-center gap-2 border-t border-border pt-3 md:justify-end ${actionControlLayout}`}
              >
                {participationAction}
                {watch}
                {overflowAction}
              </div>
            </div>
          </div>
          <details className="border-t border-border pt-3 xl:hidden">
            <summary className="max-w-full cursor-pointer content-center rounded-lg text-sm font-semibold hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              {m.board_community_about()}
            </summary>
            <div className="mt-3 min-w-0 space-y-4 rounded-2xl bg-muted/40 p-4 [overflow-wrap:anywhere] [&_a]:max-w-full [&_a]:whitespace-normal [&_pre]:whitespace-pre-wrap">
              <BoardCommunityAboutBody page={page} postingInterval={postingInterval} />
            </div>
          </details>
        </div>
      </header>
      <div className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_17rem]">
        <BoardFeed
          key={replacement?.source === initialPage ? replacement.generation : 0}
          onOpeningRead={(page) =>
            setReplacement((previous) => ({ source: initialPage, page, generation: (previous?.generation ?? 0) + 1 }))
          }
          boardId={board.id}
          sort={sort}
          page={threads}
          openingCards={page.openingCards}
          openingRows={page.openingRows}
          {...(navigation ? { navigation } : {})}
          {...(reactionOrigin === undefined ? {} : { reactionOrigin })}
          authors={authors}
          now={now}
          {...(cursor === undefined ? {} : { cursor })}
        />
        <aside className="hidden min-w-0 xl:block" aria-labelledby={aboutHeadingId}>
          <ContentItemFrame
            as="div"
            className="min-w-0 space-y-5 rounded-2xl bg-card p-5 [overflow-wrap:anywhere] [&_a]:max-w-full [&_a]:whitespace-normal [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-2 [&_a:focus-visible]:outline-ring [&_pre]:whitespace-pre-wrap"
          >
            <ContentItemHeading id={aboutHeadingId} className="text-lg leading-snug font-semibold">
              {m.board_community_about()}
            </ContentItemHeading>
            <BoardCommunityAboutBody page={page} postingInterval={postingInterval} />
          </ContentItemFrame>
        </aside>
      </div>
    </article>
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
  restart,
}: {
  state: 'loading' | 'error' | 'closed' | 'restart';
  onRetry?: () => void;
  restart?: { boardId: string; sort: BoardSort; returnTo?: string | undefined };
}) {
  return (
    <section className="w-full max-w-6xl rounded-2xl bg-card px-4 py-6 sm:px-8 sm:py-8" aria-busy={state === 'loading'}>
      <PageHeading>
        {state === 'closed'
          ? m.platform_closed_heading()
          : state === 'loading'
            ? m.board_threads_heading()
            : state === 'restart'
              ? m.board_threads_heading()
              : m.error_heading()}
      </PageHeading>
      <p role="status" className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
        {state === 'closed'
          ? m.platform_closed_message()
          : state === 'loading'
            ? m.board_community_loading()
            : state === 'restart'
              ? m.board_reading_invalid_cursor()
              : m.error_message()}
      </p>
      {state === 'restart' && restart ? (
        <a
          href={boardRequestHref(getLocale(), restart.boardId, {
            ...(restart.sort === 'active' ? {} : { sort: restart.sort }),
            ...(restart.returnTo ? { returnTo: restart.returnTo } : {}),
          })}
          className={buttonVariants({
            variant: 'outline',
            className: 'mt-4 h-auto min-h-7 max-w-full whitespace-normal',
          })}
        >
          {m.board_reading_restart()}
        </a>
      ) : null}
      {state === 'error' && onRetry ? (
        <Button
          variant="outline"
          className="mt-4 h-auto min-h-7 max-w-full whitespace-normal"
          onClick={onRetry}
        >
          {m.board_community_retry()}
        </Button>
      ) : null}
    </section>
  );
}
