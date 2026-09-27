import { UserRoundIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import type { CatalogueWork } from '../catalogue/work.ts';
import { WorkShelf } from '../catalogue/work-shelf.tsx';
import type { WorkPageMessages } from './messages.ts';
import { workHref } from './route.ts';
import type { AgentCredit, AgentWorksPage, Loaded } from './types.ts';

/**
 * About the author and a "More by" shelf, as Goodreads closes a book page.
 * It names the first native author credit; the profile page it will link to
 * (`/@handle`) is a later slice. Works Main could not list are left out
 * quietly: the section is an invitation, not the Work's record.
 */
export function AuthorSection({ credit, works, work, avatarQuery, locale, messages }: {
  credit: AgentCredit; works: Loaded<AgentWorksPage>; work: string; avatarQuery?: string; locale: UiLocale;
  messages: WorkPageMessages;
}) {
  const t = materializeData(messages, { locale });
  const others: CatalogueWork[] = works.ok ? works.data.items.filter(item => item.id !== work).map(item => ({
    id: item.id, href: workHref(item.id.slice(-36)), title: item.title, cover: item.cover, kind: 'book',
    authors: [credit.displayName], rating: null })) : [];
  return <section aria-labelledby="work-author" className="grid min-w-0 gap-6 border-border/70 border-t pt-8">
    <h2 id="work-author" className="font-semibold text-xl tracking-tight">{t.aboutAuthor}</h2>
    <div className="flex items-center gap-4">
      <span className="grid size-14 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
        <UserRoundIcon aria-hidden="true" className="size-6" /></span>
      <p className="grid min-w-0">
        <span className="truncate font-medium font-work-title text-lg">{credit.displayName}</span>
        <span className="truncate text-muted-foreground text-sm">@{credit.handle}</span>
      </p>
    </div>
    {others.length ? <WorkShelf heading={{ title: t.moreBy({ name: credit.displayName }) }} works={others}
      avatarQuery={avatarQuery} locale={locale} /> : null}
  </section>;
}
