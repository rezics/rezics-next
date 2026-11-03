import { useId, type ReactNode } from 'react';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import {
  CommunityBanner,
  CommunityAvatar,
  CommunityMemberCount,
  CommunityRules,
  ImageCredit,
} from '../community/community-presentation-parts';
import { Badge } from '@rezics/ui/shadcn/badge';
import { Button } from '@rezics/ui/shadcn/button';
import { Menu } from '@rezics/ui/menu';
import { EllipsisIcon } from 'lucide-react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { BoardContext } from './thread-context';
import { BoardFeed } from './board-feed';
import type { CommunityBoardPage } from './board-feed-data';
import type { BoardSort } from './board-sort';

/** One owned community region, reused by the actual route and Patterns. The shell owns surrounding navigation. */
export function BoardCommunity({
  page,
  sort,
  participation,
  start,
  overflow,
  postingInterval,
}: {
  page: CommunityBoardPage;
  sort: BoardSort;
  participation?: ReactNode;
  start?: ReactNode;
  overflow?: ReactNode;
  postingInterval?: ReactNode;
}) {
  const aboutHeadingId = useId();
  const rulesHeadingId = useId();
  const { board, realm, threads, authors, now } = page;
  const title = board.title ?? m.threads_untitled();
  const community = page.community?.state === 'available' ? page.community.value : null;
  const name = community?.name ?? realm?.title ?? title;
  // An authored empty summary must not fall back to another container's description.
  const summary = community ? community.description : realm?.summary;
  const avatar = community?.avatar.state === 'available' ? community.avatar.value : null;
  const banner = community?.banner.state === 'available' ? community.banner.value : null;
  const rules = community?.rules;
  const contextRealm = community ? { id: community.realmId, title: community.name } : realm;
  return (
    <article className="w-full min-w-0 max-w-6xl space-y-6 text-foreground" data-slot="board-community">
      <header className="overflow-hidden rounded-3xl bg-card">
        <CommunityBanner banner={banner} realmId={community?.realmId ?? realm?.id ?? board.realmId} />
        <div className="space-y-4 px-4 pb-5 sm:px-6 sm:pb-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <CommunityAvatar avatar={avatar} name={name} realmId={community?.realmId ?? realm?.id ?? board.realmId} />
            <div className="flex max-w-full flex-wrap items-center gap-2 pt-3">
              {participation}
              {overflow ?? <BoardCommunityMenu boardId={board.id} />}
            </div>
          </div>
          <BoardContext realm={contextRealm} />
          <PageHeading className="break-words text-2xl sm:text-3xl">{title}</PageHeading>
          {summary ? <p className="line-clamp-1 max-w-3xl text-muted-foreground">{summary}</p> : null}
          {board.realmId !== null ? (
            <div data-slot="board-community-members">
              <CommunityMemberCount members={community?.members} />
            </div>
          ) : null}
          {board.visibility === 'protected' ? <Badge variant="secondary">{m.board_community_protected()}</Badge> : null}
        </div>
      </header>
      <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <BoardFeed boardId={board.id} sort={sort} page={threads} authors={authors} now={now} actions={start} />
        <aside className="min-w-0" aria-labelledby={aboutHeadingId}>
          <ContentItemFrame
            as="div"
            className="min-w-0 space-y-5 rounded-2xl bg-card p-5 [overflow-wrap:anywhere] [&_a]:max-w-full [&_a]:whitespace-normal [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-2 [&_a:focus-visible]:outline-ring [&_pre]:whitespace-pre-wrap"
          >
            <ContentItemHeading id={aboutHeadingId} className="text-lg leading-snug font-semibold">
              {m.board_community_about()}
            </ContentItemHeading>
            {summary ? (
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{summary}</p>
            ) : null}
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
        <Button variant="ghost" size="icon" className="min-h-11 min-w-11" aria-label={m.board_more_actions()}>
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
        <Button variant="outline" className="mt-4 min-h-11 min-w-11" onClick={onRetry}>
          {m.board_community_retry()}
        </Button>
      ) : null}
    </section>
  );
}
