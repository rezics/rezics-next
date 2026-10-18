import type { UiLocale } from '../../../i18n/define.ts';
import type { WorkPageMessages } from '../messages.ts';

export interface GuideSection { heading: string; paragraphs: string[]; id: string }

/** Plain text and Markdown headings both retain the author's paragraph order. */
export function guideSections(body: string, title: string): GuideSection[] {
  const lines = body.split(/\r?\n/);
  const sections: GuideSection[] = [];
  let current: GuideSection | null = null;
  for (const line of lines) {
    const heading = /^#{1,6}\s+(.+)$/.exec(line)?.[1] ?? null;
    const firstTitle = !sections.length && !current && line.trim() === title;
    if (heading || firstTitle) {
      if (current) sections.push(current);
      current = { heading: heading ?? title, paragraphs: [], id: `guide-section-${sections.length + 1}` };
    } else if (line.trim()) {
      if (!current) current = { heading: title, paragraphs: [], id: 'guide-section-1' };
      current.paragraphs.push(line.trim());
    }
  }
  if (current) sections.push(current);
  return sections;
}

export function GuideExperience({ body, title, updatedAt, locale, messages: t }: {
  body: string; title: string; updatedAt: string | null; locale: UiLocale; messages: WorkPageMessages;
}) {
  const sections = guideSections(body, title);
  const words = body.match(/[A-Za-z0-9]+/g)?.length ?? 0;
  const cjk = body.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
  const minutes = Math.max(1, Math.ceil(words / 200 + cjk / 400));
  const contents = <ol className="grid gap-2 text-sm">{sections.map(section => <li key={section.id}>
    <a className="rounded-sm text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2
      focus-visible:ring-ring" href={`#${section.id}`}>{section.heading}</a>
  </li>)}</ol>;
  return <section id="guide-experience" aria-label={title} className="grid min-w-0 scroll-mt-8 gap-5">
    <div className="flex flex-wrap gap-x-5 gap-y-1 text-muted-foreground text-sm">
      <span>{minutes} {t.minutesRead}</span>
      {updatedAt ? <span>{t.lastUpdated}: {new Intl.DateTimeFormat(locale,
        { dateStyle: 'medium' }).format(new Date(updatedAt))}</span> : null}
    </div>
    <div className={sections.length > 1 ? 'grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,70ch)_minmax(10rem,1fr)]' : 'min-w-0'}>
      {sections.length > 1 ? <details className="rounded-xl border p-4 xl:hidden">
        <summary className="cursor-pointer rounded-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {t.tableOfContents}</summary>
        <nav aria-label={t.tableOfContents} className="mt-3">{contents}</nav>
      </details> : null}
      <article className="grid min-w-0 max-w-[70ch] gap-6 [overflow-wrap:anywhere]">
        {sections.map(section => <section id={section.id} key={section.id} className="grid scroll-mt-8 gap-3">
          {sections.length === 1 && section.heading === title ? null
            : <h2 className="font-semibold text-lg">{section.heading}</h2>}
          {section.paragraphs.map((paragraph, index) => <p key={index} className="leading-7">{paragraph}</p>)}
        </section>)}
      </article>
      {sections.length > 1 ? <nav aria-label={t.tableOfContents} className="hidden min-w-0 rounded-xl border p-4 xl:block">
        <h2 className="mb-3 font-semibold text-sm">{t.tableOfContents}</h2>{contents}
      </nav> : null}
    </div>
  </section>;
}
