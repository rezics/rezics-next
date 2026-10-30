import { useEffect, useRef, useState } from 'react';
import { useOperation } from '../kernel/exposure';
import { sharedRatio } from '@rezics/ui/cover';
import { CoverCard, CoverRow } from '@rezics/ui/cover-card';
import { Button } from '@rezics/ui/shadcn/button';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { coverSrc } from '../media/cover-src';
import { coverOf, coverSubject } from '../media/summary';
import { m } from '../paraglide/messages.js';
import type { Locale } from '../paraglide/runtime.js';
import { subjectHref } from '../subject/subject-href';
import { progressView } from './progress-label';
import { pageText } from '../features/pages/shared';
import { SectionHeading } from './section-heading';
import type { ContinueEntry } from './continue-read';

/**
 * What the visitor is in the middle of. Each card is a cover card: one link to carry on, on its title and stretched
 * over the whole card, named for what it does to that title, and a menu that opens the subject's page. The card
 * holds the cover, the title and one progress row. It uses the same scrollable cover row and card size at every
 * viewport, so it stays aligned with the catalogue rows.
 */
export function ContinueRow({ entries, locale }: { entries: ContinueEntry[]; locale: string }) {
  const admitted = useOperation('progress_session.list');
  const rowHost = useRef<HTMLDivElement>(null);
  const [canScrollBack, setCanScrollBack] = useState(false);
  const [canScrollForward, setCanScrollForward] = useState(false);
  const options = { locale: locale as Locale };
  const subjects = entries.map((entry) => ({
    entry,
    subject: coverSubject(entry.subjectId, entry.label, entry.summary),
  }));
  const ratio = sharedRatio(subjects.map(({ subject }) => subject));
  const cards = subjects.map(({ entry, subject }) => {
    const progress = progressView(entry.progress, locale);
    const progressLabel = progress?.text ?? entry.stateLabel;
    const localizedTitle = pageText(entry.language ? { [entry.language]: entry.label } : entry.label, locale);
    const title = localizedTitle.text || m.subject_value_unlabelled();
    const href = entry.progress
      ? `/${locale}/library/progress/${encodeURIComponent(entry.progress.sessionId)}`
      : `/${locale}/library/progress?subjectId=${encodeURIComponent(entry.subjectId)}`;
    return (
      <CoverCard
        key={entry.subjectId}
        {...(admitted ? { href } : {})}
        cover={{ subject, cover: coverOf(entry.summary), src: coverSrc }}
        title={title}
        {...(localizedTitle.lang ? { titleLang: localizedTitle.lang } : {})}
        linkLabel={m.home_continue_label({ title }, options)}
        {...(progressLabel
          ? {
              progress: {
                value: progress?.percent == null ? null : progress.percent / 100,
                label: progressLabel,
              },
            }
          : {})}
        menuLabel={m.home_continue_actions({ title }, options)}
        menuEntries={[
          {
            type: 'link',
            label: m.home_continue_open_subject({}, options),
            href: subjectHref({ id: entry.subjectId, label: title }, locale).href,
          },
        ]}
      />
    );
  });
  useEffect(() => {
    const row = rowHost.current?.querySelector<HTMLElement>('[data-slot="cover-row"]');
    if (!row) return;
    const update = () => {
      setCanScrollBack(row.scrollLeft > 1);
      setCanScrollForward(row.scrollLeft + row.clientWidth < row.scrollWidth - 1);
    };
    update();
    row.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(row);
    return () => {
      row.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, [entries.length]);
  return (
    <>
      <SectionHeading>{m.home_continue_heading()}</SectionHeading>
      <div ref={rowHost} className="relative">
        <CoverRow ratio={ratio} label={m.home_continue_heading()}>
          {cards}
        </CoverRow>
        <Button
          type="button"
          variant="secondary"
          size="icon-sm"
          aria-label={m.home_continue_previous()}
          aria-hidden={!canScrollBack}
          data-available={canScrollBack}
          tabIndex={canScrollBack ? 0 : -1}
          disabled={!canScrollBack}
          onClick={() =>
            rowHost.current?.querySelector('[data-slot="cover-row"]')?.scrollBy({ left: -240, behavior: 'smooth' })
          }
          className="pointer-fine:flex pointer-coarse:hidden absolute top-1/2 left-1 z-20 hidden -translate-y-1/2 shadow-md data-[available=false]:hidden"
        >
          <ChevronLeft aria-hidden />
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="icon-sm"
          aria-label={m.home_continue_next()}
          aria-hidden={!canScrollForward}
          data-available={canScrollForward}
          tabIndex={canScrollForward ? 0 : -1}
          disabled={!canScrollForward}
          onClick={() =>
            rowHost.current?.querySelector('[data-slot="cover-row"]')?.scrollBy({ left: 240, behavior: 'smooth' })
          }
          className="pointer-fine:flex pointer-coarse:hidden absolute top-1/2 right-1 z-20 hidden -translate-y-1/2 shadow-md data-[available=false]:hidden"
        >
          <ChevronRight aria-hidden />
        </Button>
      </div>
    </>
  );
}

/** Keep the signed-in slot's final height while the browser waits for personal library data. */
export function ContinueSection({ entries, locale }: { entries: ContinueEntry[]; locale: string }) {
  return entries.length > 0 ? (
    <ContinueRow entries={entries} locale={locale} />
  ) : (
    <div aria-hidden="true" className="min-h-[20rem] sm:min-h-[24rem]" />
  );
}
