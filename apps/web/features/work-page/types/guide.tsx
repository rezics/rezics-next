import type { UiLocale } from '../../../i18n/define.ts';
import type { WorkPageMessages } from '../messages.ts';
import { Region } from '../region.tsx';

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
  return <Region id="guide-experience" title={t.guideRead}>
    <div className="flex flex-wrap gap-x-5 gap-y-1 text-muted-foreground text-sm">
      <span>{minutes} {t.minutesRead}</span>
      {updatedAt ? <span>{t.lastUpdated}: {new Intl.DateTimeFormat(locale,
        { dateStyle: 'medium' }).format(new Date(updatedAt))}</span> : null}
    </div>
    {sections.length ? <nav aria-label={t.tableOfContents} className="rounded-xl border p-4">
      <h3 className="mb-2 font-semibold">{t.tableOfContents}</h3>
      <ol className="grid gap-1 text-sm">{sections.map(section => <li key={section.id}>
        <a className="text-primary hover:underline" href={`#${section.id}`}>{section.heading}</a>
      </li>)}</ol>
    </nav> : null}
    <article className="grid gap-6">{sections.map(section => <section id={section.id} key={section.id}
      className="scroll-mt-8 grid gap-3">
      <h3 className="font-semibold text-lg">{section.heading}</h3>
      {section.paragraphs.map((paragraph, index) => <p key={index} className="leading-7">{paragraph}</p>)}
    </section>)}</article>
  </Region>;
}
