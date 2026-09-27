import { Badge } from '@rezics/ui/badge';
import { LockIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import { Expandable } from './expandable.tsx';
import type { UiLocale } from '../../i18n/define.ts';
import { languageName, paragraphs, typeNames } from './format.ts';
import type { WorkPageMessages } from './messages.ts';
import type { WorkHeader as Header } from './types.ts';

/**
 * The Work's identity beside its cover, in Goodreads' order: title in the
 * Work-title face, who made it, the rating summary, and a plain line of what
 * it is. Model detail (Main Version, identifiers) lives in Details below.
 */
export function WorkHeader({ work, credits, ratingLine, locale, messages }: {
  work: Header; credits: ReactNode; ratingLine?: ReactNode; locale: UiLocale; messages: WorkPageMessages;
}) {
  const t = materializeData(messages, { locale });
  const types = typeNames(work.types, t);
  // What it is, in words a reader uses: "Book · English · Completed · 24 chapters · 86,400 words".
  const facts = [types[0], work.selectedLanguage ? languageName(work.selectedLanguage, locale) : null,
    work.completionStatus ? t[work.completionStatus] : null,
    work.chapterCount ? t.chapters(work.chapterCount) : null, work.wordCount ? t.words(work.wordCount) : null]
    .filter(fact => fact !== undefined && fact !== null);
  return <header className="grid min-w-0 content-start justify-items-center gap-3 text-center lg:justify-items-start
    lg:text-start">
    {work.disclosure === 'restricted'
      ? <Badge variant="warning" title={t.restrictedHelp}><LockIcon aria-hidden="true" />{t.restricted}</Badge> : null}
    <h1 lang={work.title.language} dir={work.title.direction} className="text-balance font-semibold font-work-title
      text-3xl/tight tracking-tight [overflow-wrap:anywhere] sm:text-[2.75rem]/[1.12]">{work.title.value}</h1>
    {work.tagline ? <p lang={work.tagline.language} dir={work.tagline.direction}
      className="max-w-2xl text-pretty font-medium text-foreground/80 text-lg">{work.tagline.value}</p> : null}
    {work.title.basis === 'fallback' ? <p className="text-muted-foreground text-xs">
      {t.titleFallback({ requested: languageName(locale, locale), shown: languageName(work.title.language, locale) })}
    </p> : null}
    {work.originalTitle && work.originalTitle.value !== work.title.value
      ? <p className="text-muted-foreground text-sm">{t.originalTitle}{': '}
        <span lang={work.originalTitle.language} dir={work.originalTitle.direction}
          className="font-work-title text-foreground">{work.originalTitle.value}</span></p> : null}
    {credits}
    {ratingLine}
    {facts.length ? <p className="text-muted-foreground text-sm">{facts.join(' · ')}</p> : null}
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
