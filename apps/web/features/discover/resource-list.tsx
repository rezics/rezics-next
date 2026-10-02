import { buttonVariants } from '@rezics/ui/button';
import type { UiLocale } from '../../i18n/define.ts';
import { CommunityIcon } from '../shell/community-icon.tsx';
import Link from '../shell/localized-link.tsx';
import { resourceHref, spaceHref } from '../address/path.ts';
import type { ListPage, ResourceCard } from './api.ts';
import { browseMessages } from './browse-messages.ts';
import { browseHref, type BrowseState } from './browse-state.ts';

export function browseResourceHref(item: Pick<ResourceCard, 'kind' | 'id'>): string {
  switch (item.kind) {
    case 'work':
      return resourceHref('/w/', item.id);
    case 'realm':
      return spaceHref(item.id, 'community');
    case 'site':
      return resourceHref('/e/', item.id);
    case 'agent':
      return resourceHref('/a/', item.id);
    case 'collection':
      return resourceHref('/e/', item.id);
    case 'concept':
      return resourceHref('/concepts/', item.id);
    case 'space':
      return resourceHref('/e/', item.id);
  }
}
/** The same resource cards serve every tab and every section. Names retain their written language. */
export function ResourceList({
  items,
  locale,
  avatarQuery = '',
}: {
  items: readonly ResourceCard[];
  locale: UiLocale;
  avatarQuery?: string;
}) {
  const t = browseMessages[locale];
  return items.length ? (
    <ul className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => (
        <li key={item.id} className="min-w-0">
          <Link
            href={browseResourceHref(item)}
            className="flex h-full min-w-0 items-start gap-3 rounded-2xl border
        border-border/70 bg-card p-4 outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <CommunityIcon
              icon={item.icon}
              name={item.name.value}
              person={item.kind === 'agent'}
              size="md"
              avatarQuery={avatarQuery}
            />
            <bdi
              lang={item.name.language}
              dir={item.name.direction}
              className="min-w-0 break-words font-medium"
            >
              {item.name.value}
            </bdi>
          </Link>
        </li>
      ))}
    </ul>
  ) : (
    <p className="text-muted-foreground text-sm">{t.empty}</p>
  );
}
export function BrowseContinuation({
  page,
  state,
  locale,
}: {
  page: ListPage<unknown>;
  state: BrowseState;
  locale: UiLocale;
}) {
  const t = browseMessages[locale];
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p role="status" className="text-muted-foreground text-sm">
        {page.count.kind === 'at-least' ? `${t.atLeast} ` : ''}
        {new Intl.NumberFormat(locale).format(page.count.value)} {t.results}
      </p>
      <nav aria-label={t.results} className="flex flex-wrap gap-2">
        {state.cursor ? (
          <Link
            href={browseHref({ ...state, cursor: null })}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            {t.first}
          </Link>
        ) : null}
        {!page.complete && page.nextCursor ? (
          <Link
            href={browseHref({ ...state, cursor: page.nextCursor })}
            rel="next"
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            {t.more}
          </Link>
        ) : null}
      </nav>
    </div>
  );
}
