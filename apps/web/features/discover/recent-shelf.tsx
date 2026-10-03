import type { UiLocale } from '../../i18n/define.ts';
import { discoveryApi } from './api.ts';
import { browseHref, emptyBrowse } from './browse-state.ts';
import { browseMessages } from './browse-messages.ts';
import { readBrowse } from './load.ts';
import { ResourceList } from './resource-list.tsx';
import { browseReader } from './server.ts';
import Link from '../shell/localized-link.tsx';

/** Home's preview uses Main's section and offers its complete traversal. */
export async function RecentShelf({ locale }: { locale: UiLocale }) {
  const reader = await browseReader();
  const read = await readBrowse(() =>
    discoveryApi(reader.personal, locale, reader.actingSubject).sections({
      section: 'popular',
      limit: 6,
    }),
  );
  if (!read.ok || !read.data.items[0]?.page.items.length) return null;
  const section = read.data.items[0],
    t = browseMessages[locale];
  return (
    <section aria-label={t.popular} className="grid gap-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-semibold text-xl">{t.popular}</h2>
        <Link
          href={browseHref({ ...emptyBrowse, section: section.id })}
          className="text-primary text-sm hover:underline"
        >
          {t.seeAll}
        </Link>
      </div>
      <ResourceList items={section.page.items} locale={locale} avatarQuery={reader.avatarQuery} />
    </section>
  );
}
