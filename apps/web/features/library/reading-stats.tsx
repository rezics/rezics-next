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
    <div className="grid gap-3 text-sm sm:grid-cols-2">
      {data.averageRating !== null && <p>{t.averageRating({ rating: number(data.averageRating),
        count: number(data.ratedBooks) })}</p>}
      {data.booksWithChapters > 0 && <p>{t.knownChapters({ count: number(data.knownChapters),
        books: number(data.booksWithChapters) })}</p>}
      {data.topConcepts.length > 0 && <div><h3 className="font-medium">{t.topConcepts}</h3>
        <ol className="flex flex-wrap gap-2">{data.topConcepts.map(item =>
          <li key={item.name} className="rounded-full bg-background px-3 py-1">
            {item.name} · {number(item.count)}</li>)}</ol></div>}
      {data.titleLanguages.length > 0 && <div><h3 className="font-medium">{t.titleLanguages}</h3>
        <ol className="flex flex-wrap gap-2">{data.titleLanguages.map(item =>
          <li key={item.language} className="rounded-full bg-background px-3 py-1">
            {item.language} · {number(item.count)}</li>)}</ol></div>}
    </div>
    <div>
      <ol aria-label={title} className="grid grid-cols-6 gap-x-1 gap-y-4 sm:grid-cols-12 sm:gap-2">
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
