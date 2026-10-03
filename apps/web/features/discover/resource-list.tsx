import { buttonVariants } from '@rezics/ui/button';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import Link from '../shell/localized-link.tsx';
import { slotRatio } from '../catalogue/work.ts';
import { WorkGrid } from '../catalogue/work-shelf.tsx';
import type { ListPage, ResourceCard } from './api.ts';
import { browseMessages } from './browse-messages.ts';
import { browseHref, type BrowseState } from './browse-state.ts';
import { browseCounts } from './count-messages.ts';
import { DiscoverResourceCard, resourceWork } from './resource-card.tsx';
import type { BrowseScope } from './scope.ts';

export { browseResourceHref } from './resource-card.tsx';
/** The same resource cards serve every tab and every section. Names retain their written language. */
export function ResourceList({
  items,
  locale,
  avatarQuery = '',
  scope = { kind: 'global' },
  headingLevel = 3,
}: {
  items: readonly ResourceCard[];
  locale: UiLocale;
  avatarQuery?: string;
  scope?: BrowseScope;
  headingLevel?: 2 | 3 | 4;
}) {
  const t = browseMessages[locale];
  const works = items.filter(item => item.kind === 'work').map(item => resourceWork(item, scope, locale));
  if (works.length && works.length === items.length) return <WorkGrid works={works}
    locale={locale} avatarQuery={avatarQuery} headingLevel={headingLevel} />;
  const slot = slotRatio(works);
  return items.length ? (
    <ul className="grid min-w-0 items-start gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => (
        <li key={item.id} className="min-w-0">
          <DiscoverResourceCard item={item} locale={locale} avatarQuery={avatarQuery} slot={slot} scope={scope}
            headingLevel={headingLevel} />
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
  const counts = materializeData(browseCounts[locale], { locale });
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p role="status" className="text-muted-foreground text-sm">
        {page.count.kind === 'at-least' ? counts.atLeastResults(page.count.value) : counts.results(page.count.value)}
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
