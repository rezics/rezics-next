import { initials } from '@rezics/ui/avatar-initials';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import type { CatalogueWork } from '../catalogue/work.ts';
import { coverKindOf } from '../catalogue/work.ts';
import { WorkShelf } from '../catalogue/work-shelf.tsx';
import { authorHref } from '../author/route.ts';
import type { AuthorWorksPage } from '../author/types.ts';
import Link from '../shell/localized-link.tsx';
import type { WorkPageMessages } from './messages.ts';
import { workHref } from './route.ts';
import type { AgentWorksPage, Loaded } from './types.ts';

export type WorkAuthor =
  | { kind: 'agent'; name: string; handle: string; works: Loaded<AgentWorksPage> }
  | { kind: 'external'; name: string; key: string; years: string | null; works: Loaded<AuthorWorksPage> };

/**
 * About the author and a "More by" shelf, as Goodreads closes a book page.
 * It names the first author credit and links to their REZICS page.
 * Works Main could not list are left out quietly: the section
 * is an invitation, not the Work's record.
 */
export function AuthorSection({ author, work, avatarQuery, locale, messages }: {
  /** The Work being shown, as an IRI or its UUID; it is not offered again. */
  author: WorkAuthor; work: string; avatarQuery?: string; locale: UiLocale;
  messages: WorkPageMessages;
}) {
  const t = materializeData(messages, { locale });
  const items = author.works.ok ? author.works.data.items.filter(item => item.id.slice(-36) !== work.slice(-36)) : [];
  const others: CatalogueWork[] = items.map(item => ({
    id: item.id, href: workHref(item.id.slice(-36)), title: item.title, cover: item.cover,
    kind: coverKindOf(item.types),
    authors: [{ name: author.name, href: author.kind === 'agent'
      ? authorHref({ kind: 'agent', handle: author.handle })
      : authorHref({ kind: 'external', key: author.key }) }], rating: null }));
  return <section aria-labelledby="work-author" className="grid min-w-0 gap-6 border-border/70 border-t pt-8">
    <h2 id="work-author" className="font-semibold text-xl tracking-tight">{t.aboutAuthor}</h2>
    <Link href={author.kind === 'agent' ? authorHref({ kind: 'agent', handle: author.handle })
      : authorHref({ kind: 'external', key: author.key })}
      className="flex w-fit items-center gap-4 rounded-full pe-4 outline-none
      hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring">
      <span className="grid size-14 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
        <span aria-hidden="true" className="font-semibold font-work-title text-xl leading-none">
          {initials(author.name)}</span></span>
      <span className="grid min-w-0">
        <span className="truncate font-medium font-work-title text-lg">{author.name}</span>
        {author.kind === 'agent' ? <span className="truncate text-muted-foreground text-sm">@{author.handle}</span>
          : author.years ? <span className="truncate text-muted-foreground text-sm">{author.years}</span> : null}
      </span>
    </Link>
    {others.length ? <WorkShelf heading={{ title: t.moreBy({ name: author.name }) }} works={others}
      avatarQuery={avatarQuery} locale={locale} /> : null}
  </section>;
}
