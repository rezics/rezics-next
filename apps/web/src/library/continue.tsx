import { Cover, sharedRatio } from '@rezics/ui/cover';
import { Progress, ProgressLabel } from '@rezics/ui/shadcn/progress';
import { coverSrc } from '../media/cover-src';
import { coverOf, coverSubject } from '../media/summary';
import { m } from '../paraglide/messages.js';
import type { Locale } from '../paraglide/runtime.js';
import type { ContinueEntry, ContinueProgress } from './continue-read';

/** `text` already says the share when the unit is a percent, so the bar does not repeat it beside the text. */
type ProgressView = { text: string; percent: number | null; shared: boolean };

function amountOf(value: string | null): number | null {
  if (value === null) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

/**
 * The progress the kernel returned, in the reader's language: the unit and total of an amount ("Episode 3 of 12")
 * or the count of completed units, with the share of the total when there is one. A reading position has no
 * human-readable form, and neither has a session that holds no amount yet, so each says only that it is in progress.
 */
export function progressView(progress: ContinueProgress | null, locale: string): ProgressView | null {
  if (!progress) return null;
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const options = { locale: locale as Locale };
  const inProgress = { text: m.home_continue_in_progress({}, options), percent: null, shared: false };
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
    shared: progress.unit === 'percent',
  };
}

/**
 * What the visitor is in the middle of. Each card is one link to carry on, on its title and stretched over the whole
 * card, named for what it does to that title; the card holds the subject's cover, the title and how far the visitor
 * has come. On a phone the cards are one row that
 * scrolls sideways, each a thumbnail beside its text, so the search box and the catalogue stay on the first screen.
 */
export function ContinueRow({ entries, locale }: { entries: ContinueEntry[]; locale: string }) {
  const subjects = entries.map((entry) => ({
    entry,
    subject: coverSubject(entry.subjectId, entry.label, entry.summary),
  }));
  const ratio = sharedRatio(subjects.map(({ subject }) => subject));
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
  return (
    <>
      <h2 className="font-serif text-xl font-semibold tracking-tight">{m.home_continue_heading()}</h2>
      <ul className="-m-1 flex snap-x gap-3 overflow-x-auto p-1 [scrollbar-width:none] sm:m-0 sm:grid sm:grid-cols-3 sm:overflow-visible sm:p-0 lg:grid-cols-6 [&::-webkit-scrollbar]:hidden">
        {subjects.map(({ entry, subject }) => {
          const progress = progressView(entry.progress, locale);
          const lang =
            entry.language && entry.language.toLowerCase() !== locale.toLowerCase() ? entry.language : undefined;
          const title = entry.label || m.subject_value_unlabelled();
          const href = entry.progress
            ? `/${locale}/library/progress/${encodeURIComponent(entry.progress.sessionId)}`
            : `/${locale}/library/progress?subjectId=${encodeURIComponent(entry.subjectId)}`;
          return (
            <li
              key={entry.subjectId}
              data-slot="continue-card"
              className="relative flex w-64 min-w-0 shrink-0 snap-start items-center gap-3 rounded-xl border border-border/70 bg-card p-2 transition-colors hover:bg-muted/50 has-[a:focus-visible]:ring-3 has-[a:focus-visible]:ring-ring/50 sm:w-auto sm:flex-col sm:items-stretch sm:p-3"
            >
              <div className="w-12 shrink-0 sm:w-full">
                <Cover
                  subject={subject}
                  cover={coverOf(entry.summary)}
                  size="fill"
                  ratio={ratio}
                  src={coverSrc}
                  decorative
                />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:contents">
                <span
                  className={`line-clamp-2 font-medium break-words ${entry.label ? 'text-foreground' : 'text-muted-foreground'}`}
                >
                  <a
                    href={href}
                    lang={lang}
                    aria-label={m.home_continue_label({ title }, { locale: locale as Locale })}
                    className="outline-none after:absolute after:inset-0 after:rounded-xl after:content-['']"
                  >
                    {title}
                  </a>
                </span>
                {progress &&
                  (progress.percent === null ? (
                    <span className="text-sm text-muted-foreground">{progress.text}</span>
                  ) : (
                    <Progress value={progress.percent} className="gap-1.5">
                      <ProgressLabel className="font-normal text-muted-foreground">{progress.text}</ProgressLabel>
                      {!progress.shared && (
                        <span className="ml-auto text-sm text-muted-foreground tabular-nums">
                          {percent.format(progress.percent / 100)}
                        </span>
                      )}
                    </Progress>
                  ))}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
