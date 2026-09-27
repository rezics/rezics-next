import { buttonVariants } from '@rezics/ui/button';
import { MessagesSquareIcon, UsersRoundIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import Link from 'next/link';
import type { UiLocale } from '../../i18n/define.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import { paragraphs } from './format.ts';
import type { WorkPageMessages } from './messages.ts';
import { Region, RegionFailure } from './region.tsx';
import { idOf, workHref } from './route.ts';
import { realmLabel, ScopeOffer, type ScopeView, scopeName } from './scope-bar.tsx';
import type { DiscussionPage, Loaded } from './types.ts';

/**
 * Replies reviewed in public Realms, newest first: from every public Realm in
 * Global, from one Realm in its scope. Main shows no author yet and keeps
 * unreviewed replies out. Mine has no discussion of its own.
 */
export function DiscussionRegion({ discussion, view, cursor, locale, messages }: {
  /** Null in Mine. */
  discussion: Loaded<DiscussionPage> | null; view: ScopeView; cursor: string | undefined; locale: UiLocale;
  messages: WorkPageMessages;
}) {
  const t = materializeData(messages, { locale });
  const name = scopeName(view, messages, locale);
  const firstPage = workHref(view.workRef, 'discussion', view.scope);
  const empty = (title: string, body?: string) => <EmptyState icon={MessagesSquareIcon} headingLevel={3} title={title}
    description={body}><ScopeOffer view={view} locale={locale} messages={messages} tab="discussion" /></EmptyState>;
  if (!discussion) {
    return <Region id="work-discussion" title={t.discussion}>{empty(t.discussionMine, t.discussionMineBody)}</Region>;
  }
  if (!discussion.ok) {
    return <Region id="work-discussion" title={t.discussion}>
      <RegionFailure title={t.discussionUnavailable} failure={discussion.failure} messages={messages}
        restartHref={firstPage} />
    </Region>;
  }
  const { items, nextCursor } = discussion.data;
  return <Region id="work-discussion" title={t.discussion}>
    <p className="text-muted-foreground text-sm">{t.discussionNote}</p>
    {items.length ? <ol className="grid gap-3">
      {items.map(item => {
        const realm = idOf(item.realm);
        const label = realm ? realmLabel(view.realms.find(entry => entry.id === realm) ?? { id: realm, name: null },
          messages, locale) : item.realm;
        return <li key={item.placement}>
          <article className="grid gap-3 rounded-xl border border-border/60 bg-background/60 p-4">
            <header className="flex flex-wrap items-center justify-between gap-2 text-xs">
              {realm && view.scope.kind !== 'realm'
                ? <Link href={workHref(view.workRef, 'discussion', { kind: 'realm', realm })}
                  className="flex items-center gap-1.5 font-medium text-primary underline-offset-4 hover:underline">
                  <UsersRoundIcon aria-hidden="true" className="size-3.5" />{t.replyIn({ realm: label })}</Link>
                : <span className="flex items-center gap-1.5 font-medium">
                  <UsersRoundIcon aria-hidden="true" className="size-3.5" />{t.replyIn({ realm: label })}</span>}
              <span className="text-muted-foreground tabular-nums">{t.sequence({ sequence: item.sequence })}</span>
            </header>
            <div className="grid gap-2 text-pretty break-words text-sm/7">
              {paragraphs(item.body).map((line, index) => <p key={index}>{line}</p>)}
            </div>
          </article>
        </li>;
      })}
    </ol> : empty(view.scope.kind === 'realm' ? t.noDiscussionRealm({ realm: name }) : t.noDiscussionGlobal)}
    {cursor || nextCursor ? <nav aria-label={t.pagination} className="flex flex-wrap justify-between gap-2">
      {cursor ? <Link href={firstPage} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
        {t.firstPage}</Link> : <span />}
      {nextCursor ? <Link href={workHref(view.workRef, 'discussion', view.scope, { cursor: nextCursor })}
        className={buttonVariants({ variant: 'outline', size: 'sm' })}>{t.nextPage}</Link> : null}
    </nav> : null}
  </Region>;
}
