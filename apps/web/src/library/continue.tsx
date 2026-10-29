import { useOperation } from '../kernel/exposure';
import { sharedRatio } from '@rezics/ui/cover';
import { CoverCard, CoverGrid, CoverRow } from '@rezics/ui/cover-card';
import { DropdownMenuItem } from '@rezics/ui/shadcn/dropdown-menu';
import { coverSrc } from '../media/cover-src';
import { coverOf, coverSubject } from '../media/summary';
import { m } from '../paraglide/messages.js';
import type { Locale } from '../paraglide/runtime.js';
import { subjectHref } from '../subject/subject-href';
import { progressView } from './progress-label';
import { SectionHeading } from './section-heading';
import type { ContinueEntry } from './continue-read';

/**
 * What the visitor is in the middle of. Each card is a cover card: one link to carry on, on its title and stretched
 * over the whole card, named for what it does to that title, and a menu that opens the subject's page. The card
 * holds the cover, the title and one progress row. On a phone the cards are one row that scrolls
 * sideways, so the search box and the catalogue stay on the first screen; from `sm` up they form a grid. Both are
 * drawn and CSS shows one, so the page does not depend on the script to choose.
 */
export function ContinueRow({ entries, locale }: { entries: ContinueEntry[]; locale: string }) {
  const admitted = useOperation('progress_session.list');
  const options = { locale: locale as Locale };
  const subjects = entries.map((entry) => ({
    entry,
    subject: coverSubject(entry.subjectId, entry.label, entry.summary),
  }));
  const ratio = sharedRatio(subjects.map(({ subject }) => subject));
  const cards = subjects.map(({ entry, subject }) => {
    const progress = progressView(entry.progress, locale);
    const lang = entry.language && entry.language.toLowerCase() !== locale.toLowerCase() ? entry.language : undefined;
    const title = entry.label || m.subject_value_unlabelled();
    const href = entry.progress
      ? `/${locale}/library/progress/${encodeURIComponent(entry.progress.sessionId)}`
      : `/${locale}/library/progress?subjectId=${encodeURIComponent(entry.subjectId)}`;
    return (
      <CoverCard
        key={entry.subjectId}
        {...(admitted ? { href } : {})}
        cover={{ subject, cover: coverOf(entry.summary), src: coverSrc }}
        title={title}
        {...(lang ? { titleLang: lang } : {})}
        linkLabel={m.home_continue_label({ title }, options)}
        progress={{
          value: progress?.percent == null ? null : progress.percent / 100,
          label: progress?.text ?? m.home_continue_in_progress({}, options),
        }}
        menuLabel={m.home_continue_actions({ title }, options)}
        menu={
          <DropdownMenuItem render={<a href={subjectHref({ id: entry.subjectId, label: title }, locale).href} />}>
            {m.home_continue_open_subject({}, options)}
          </DropdownMenuItem>
        }
      />
    );
  });
  return (
    <>
      <SectionHeading>{m.home_continue_heading()}</SectionHeading>
      <div className="sm:hidden">
        <CoverRow ratio={ratio} label={m.home_continue_heading()}>
          {cards}
        </CoverRow>
      </div>
      <div className="hidden sm:block">
        <CoverGrid ratio={ratio}>{cards}</CoverGrid>
      </div>
    </>
  );
}

/** Keep the signed-in slot's final height while the browser waits for personal library data. */
export function ContinueSection({ entries, locale }: { entries: ContinueEntry[]; locale: string }) {
  return (
    <div className="min-h-[20rem] sm:min-h-[24rem]">
      {entries.length > 0 ? <ContinueRow entries={entries} locale={locale} /> : null}
    </div>
  );
}
