import { sharedRatio } from '@rezics/ui/cover';
import { CoverCard, CoverGrid, CoverRow } from '@rezics/ui/cover-card';
import { ProgressRow } from '@rezics/ui/progress-row';
import { DropdownMenuItem } from '@rezics/ui/shadcn/dropdown-menu';
import { typeText } from '../features/pages/data';
import { coverSrc } from '../media/cover-src';
import { coverOf, coverSubject } from '../media/summary';
import { m } from '../paraglide/messages.js';
import type { Locale } from '../paraglide/runtime.js';
import type { ContinueEntry, ContinueProgress } from './continue-read';

/** `text` is the label of the one progress row; `percent` draws its bar, and is null where the kernel gives no total. */
type ProgressView = { text: string; percent: number | null };

function amountOf(value: string | null): number | null {
  if (value === null) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

/**
 * The progress the kernel returned, in the reader's language: the unit form of an amount and its total ("Ep 3/12",
 * "p. 120/310") or of the count of completed units, with the share of the total as the bar when there is one. A
 * reading position has no human-readable form, and neither has a session that holds no amount yet, so each says
 * only that it is in progress.
 */
export function progressView(progress: ContinueProgress | null, locale: string): ProgressView | null {
  if (!progress) return null;
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const options = { locale: locale as Locale };
  const inProgress = {
    text: m.home_continue_in_progress({}, options),
    percent: null,
  };
  if (progress.mode === 'cursor_position') return inProgress;
  const amount = progress.mode === 'completed_units' ? progress.completedUnitCount : amountOf(progress.amount);
  if (amount === null) return inProgress;
  const total = progress.mode === 'scalar_amount' ? amountOf(progress.total) : null;
  const shown = { amount: number.format(amount) };
  const withTotal =
    total !== null && total > 0 && progress.unit !== 'percent' ? { ...shown, total: number.format(total) } : null;
  const text =
    progress.unit === 'percent'
      ? m.home_continue_percent(shown, options)
      : withTotal
        ? m[`home_continue_${progress.unit}_of`](withTotal, options)
        : m[`home_continue_${progress.unit}`](shown, options);
  const share = progress.unit === 'percent' ? amount : total !== null && total > 0 ? (amount / total) * 100 : null;
  return {
    text,
    percent: share === null ? null : Math.min(100, Math.max(0, share)),
  };
}

/**
 * What the visitor is in the middle of. Each card is a cover card: one link to carry on, on its title and stretched
 * over the whole card, named for what it does to that title, and a menu that opens the subject's page. The card
 * holds the cover, the title, the type and one progress row. On a phone the cards are one row that scrolls
 * sideways, so the search box and the catalogue stay on the first screen; from `sm` up they form a grid. Both are
 * drawn and CSS shows one, so the page does not depend on the script to choose.
 */
export function ContinueRow({ entries, locale }: { entries: ContinueEntry[]; locale: string }) {
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
        href={href}
        cover={{ subject, cover: coverOf(entry.summary), src: coverSrc }}
        title={title}
        {...(lang ? { titleLang: lang } : {})}
        linkLabel={m.home_continue_label({ title }, options)}
        secondary={typeText(entry.summary?.type)}
        state={
          <ProgressRow
            value={progress?.percent == null ? null : progress.percent / 100}
            label={progress?.text ?? m.home_continue_in_progress({}, options)}
          />
        }
        menuLabel={m.home_continue_actions({ title }, options)}
        menu={
          <DropdownMenuItem render={<a href={`/${locale}/subjects/${encodeURIComponent(entry.subjectId)}`} />}>
            {m.home_continue_open_subject({}, options)}
          </DropdownMenuItem>
        }
      />
    );
  });
  return (
    <>
      <h2 className="font-serif text-xl font-semibold tracking-tight">{m.home_continue_heading()}</h2>
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
