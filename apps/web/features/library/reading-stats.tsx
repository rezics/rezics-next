import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import type { LibraryMessages } from './messages.ts';
import type { Loaded, ReadingYear } from './types.ts';

/** Twelve fixed months keep empty months visible instead of suggesting a shorter year. */
export function ReadingStats({ stats, locale, messages }: { stats: Loaded<ReadingYear>;
  locale: UiLocale; messages: LibraryMessages }) {
  if (!stats.ok) return null;
  const { data } = stats;
  const t = materializeData(messages, { locale });
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const maximum = Math.max(1, ...data.months.map(month => month.books));
  const title = t.readingStats({ year: String(data.year) });
  return <section aria-labelledby="library-reading-stats" className="grid gap-5 rounded-2xl bg-muted/50 p-4 sm:p-6">
    <div className="grid gap-1">
      <h2 id="library-reading-stats" className="font-semibold text-xl">{title}</h2>
      <p className="flex flex-wrap gap-x-4 text-muted-foreground text-sm tabular-nums">
        <span>{t.booksFinished({ count: number(data.books) })}</span>
        <span>{t.chaptersFinished({ count: number(data.chapters) })}</span></p>
    </div>
    <div className="-mx-4 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
      <ol aria-label={title} className="grid min-w-[36rem] grid-cols-12 gap-2 sm:min-w-0">
        {data.months.map(month => {
          const name = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' })
            .format(new Date(Date.UTC(data.year, month.month - 1, 1)));
          return <li key={month.month} aria-label={t.monthStats({ month: name,
            books: number(month.books), chapters: number(month.chapters) })}
            className="grid justify-items-center gap-1 text-xs tabular-nums">
            <span className="font-medium">{number(month.books)}</span>
            <span aria-hidden="true" className="flex h-20 w-full items-end rounded-sm bg-background/70">
              <span className="block w-full rounded-sm bg-primary" style={{ height: `${month.books / maximum * 100}%` }} />
            </span>
            <span className="text-muted-foreground">{name}</span>
          </li>;
        })}
      </ol>
    </div>
  </section>;
}
