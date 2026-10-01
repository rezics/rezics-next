import { Badge } from '@rezics/ui/badge';
import { LocalizedText } from '@rezics/ui/localized-text';
import { LockIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import { Expandable } from './expandable.tsx';
import type { UiLocale } from '../../i18n/define.ts';
import { typeLabel } from '../catalogue/types.ts';
import { formatCompact } from '../catalogue/work.ts';
import { formatNumber, isoTime, languageName, paragraphs, sinceWhen, titleNeedsLanguageNote }
  from './format.ts';
import type { WorkPageMessages } from './messages.ts';
import type { WorkHeader as Header } from './types.ts';

function serialStats(work: Pick<Header, 'completionStatus' | 'chapterCount' | 'wordCount' | 'lastUpdatedAt'>,
  now: Date, locale: UiLocale, t: ReturnType<typeof materializeData<WorkPageMessages>>) {
  const updated = work.lastUpdatedAt ? sinceWhen(work.lastUpdatedAt, locale, now) : null;
  return [
    // `value` heads the strip; `text` says the same fact alone in a line.
    work.completionStatus ? { term: t.status, value: t[work.completionStatus], text: t[work.completionStatus] } : null,
    work.chapterCount ? { term: t.chapterCountLabel, value: formatNumber(work.chapterCount, locale),
      text: t.chapters(work.chapterCount) } : null,
    work.wordCount ? { term: t.wordCountLabel, value: formatCompact(work.wordCount, locale), text: t.words(work.wordCount) }
      : null,
    updated && work.lastUpdatedAt ? { term: t.lastUpdated, text: `${t.lastUpdated} ${updated}`,
      value: <time dateTime={isoTime(work.lastUpdatedAt)}>{updated}</time> } : null,
  ].filter(stat => stat !== null);
}

/**
 * A serial's state at a glance, as KadoKado and Royal Road head a book page:
 * whether it is finished, how long it is and when it last grew. Each fact
 * shows only when Main knows it; a single fact joins the plain line above
 * instead, rather than stand alone in a box.
 */
export function WorkStats({ work, now, locale, messages }: {
  work: Pick<Header, 'completionStatus' | 'chapterCount' | 'wordCount' | 'lastUpdatedAt'>; now: Date; locale: UiLocale;
  messages: WorkPageMessages;
}) {
  const stats = serialStats(work, now, locale, materializeData(messages, { locale }));
  if (stats.length < 2) return null;
  // On a phone the cells narrow their padding and share what is left, so four facts stay on one line.
  return <dl className="flex max-w-full flex-wrap justify-start divide-x divide-border/70 rounded-2xl border
    border-border/60 py-2.5">
    {stats.map(stat => <div key={stat.term} className="grid flex-auto gap-0.5 whitespace-nowrap px-2.5 text-start
      sm:min-w-20 sm:flex-none sm:px-4">
      <dt className="order-last text-muted-foreground text-xs">{stat.term}</dt>
      <dd className="font-semibold text-base tabular-nums">{stat.value}</dd>
    </div>)}
  </dl>;
}

/**
 * The Work's identity beside its cover, in Goodreads' order: title in the
 * Work-title face, who made it, the rating summary, a plain line of what it
 * is and, for a serial, its state. Model detail lives in Details below.
 */
export function WorkHeader({ work, credits, ratingLine, now = new Date(), locale, messages }: {
  work: Header; credits: ReactNode; ratingLine?: ReactNode;
  /** The moment "Updated 3 days ago" is measured from; stories fix it. */
  now?: Date;
  locale: UiLocale; messages: WorkPageMessages;
}) {
  const t = materializeData(messages, { locale });
  const kindLabel = typeLabel(work.types, locale);
  // What it is, in words a reader uses: "Book · English", and a lone serial fact ("Completed") with it.
  const single = serialStats(work, now, locale, t);
  const facts = [kindLabel, work.selectedLanguage ? languageName(work.selectedLanguage, locale) : null,
    single.length === 1 ? single[0]!.text : null].filter(fact => fact !== undefined && fact !== null);
  // One column that may shrink (`minmax(0, 1fr)`): beside a phone's thumbnail the stats would otherwise widen it.
  return <header className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start justify-items-start gap-3 text-start">
    {work.disclosure === 'restricted'
      ? <Badge variant="warning" title={t.restrictedHelp}><LockIcon aria-hidden="true" />{t.restricted}</Badge> : null}
    <h1 lang={work.title.language} dir={work.title.direction} className="text-balance font-semibold font-work-title
      text-2xl/tight tracking-tight [overflow-wrap:anywhere] sm:text-4xl/[1.12] lg:text-[2.75rem]/[1.12]">{work.title.value}</h1>
    {work.tagline ? <p lang={work.tagline.language} dir={work.tagline.direction}
      className="max-w-2xl text-pretty font-medium text-foreground/80 text-lg">{work.tagline.value}</p> : null}
    {titleNeedsLanguageNote(work.title, locale) ? <p className="text-muted-foreground text-xs">
      {t.titleFallback({ requested: languageName(locale, locale), shown: languageName(work.title.language, locale) })}
    </p> : null}
    {work.originalTitle && work.originalTitle.value !== work.title.value
      ? <p className="text-muted-foreground text-sm">{t.originalTitle}{': '}
        <LocalizedText text={work.originalTitle} className="font-work-title text-foreground" /></p> : null}
    <div className="w-full [&_p]:justify-start">{credits}</div>
    {ratingLine}
    {facts.length ? <p className="text-muted-foreground text-sm">{facts.join(' · ')}</p> : null}
    <WorkStats work={work} now={now} locale={locale} messages={messages} />
  </header>;
}

/** The Work's recorded description, in the reader's language when Main has one, folded after a few lines. */
export function WorkAbout({ work, messages }: { work: Header; messages: WorkPageMessages }) {
  if (!work.description) return null;
  return <section aria-labelledby="work-about" className="grid max-w-3xl gap-2">
    <h2 id="work-about" className="sr-only">{messages.about}</h2>
    <Expandable more={messages.showMore} less={messages.showLess}>
      <div lang={work.description.language} dir={work.description.direction}
        className="grid gap-3 text-pretty text-base/7 text-foreground/90">
        {paragraphs(work.description.value).map((line, index) => <p key={index}>{line}</p>)}
      </div>
    </Expandable>
  </section>;
}
