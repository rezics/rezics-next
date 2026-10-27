import { Cover, sharedRatio } from '@rezics/ui/cover';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { Progress, ProgressLabel } from '@rezics/ui/shadcn/progress';
import { coverSrc } from '../media/cover-src';
import { coverOf, coverSubject } from '../media/summary';
import { m } from '../paraglide/messages.js';
import type { Locale } from '../paraglide/runtime.js';
import type { ContinueEntry, ContinueProgress } from './continue-read';

type ProgressView = { text: string; percent: number | null };

function amountOf(value: string | null): number | null {
  if (value === null) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

/**
 * The progress the kernel returned, in the reader's language: the unit and total of an amount ("Episode 3 of 12")
 * or the count of completed units, with the share of the total when there is one. A reading position has no
 * human-readable form, so it shows no line.
 */
export function progressView(progress: ContinueProgress | null, locale: string): ProgressView | null {
  if (!progress || progress.mode === 'cursor_position') return null;
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const options = { locale: locale as Locale };
  const amount = progress.mode === 'completed_units' ? progress.completedUnitCount : amountOf(progress.amount);
  if (amount === null) return null;
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
  return { text, percent: share === null ? null : Math.min(100, Math.max(0, share)) };
}

/**
 * What the visitor is in the middle of. Each card is one link to carry on, so a card holds the subject's cover, its
 * title, how far the visitor has come and the one action the link performs.
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
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {subjects.map(({ entry, subject }) => {
          const progress = progressView(entry.progress, locale);
          const lang =
            entry.language && entry.language.toLowerCase() !== locale.toLowerCase() ? entry.language : undefined;
          const href = entry.progress
            ? `/${locale}/library/progress/${encodeURIComponent(entry.progress.sessionId)}`
            : `/${locale}/library/progress?subjectId=${encodeURIComponent(entry.subjectId)}`;
          return (
            <li key={entry.subjectId} data-slot="continue-card" className="min-w-0">
              <a
                href={href}
                className="group flex h-full min-w-0 flex-col gap-3 rounded-xl border border-border/70 bg-card p-3 transition-colors outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <Cover
                  subject={subject}
                  cover={coverOf(entry.summary)}
                  size="fill"
                  ratio={ratio}
                  src={coverSrc}
                  decorative
                />
                <span
                  lang={lang}
                  className={`line-clamp-2 font-medium break-words ${entry.label ? 'text-foreground' : 'text-muted-foreground'}`}
                >
                  {entry.label || m.subject_value_unlabelled()}
                </span>
                {progress &&
                  (progress.percent === null ? (
                    <span className="text-sm text-muted-foreground">{progress.text}</span>
                  ) : (
                    <Progress value={progress.percent} className="gap-1.5">
                      <ProgressLabel className="font-normal text-muted-foreground">{progress.text}</ProgressLabel>
                      <span className="ml-auto text-sm text-muted-foreground tabular-nums">
                        {percent.format(progress.percent / 100)}
                      </span>
                    </Progress>
                  ))}
                <span className={`${buttonVariants({ variant: 'secondary' })} mt-auto w-full`}>
                  {m.home_continue_action()}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </>
  );
}
