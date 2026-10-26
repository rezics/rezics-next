import { pageText } from '../features/pages/data';
import { m } from '../paraglide/messages.js';
import type { ContinueEntry } from './continue-read';

const linkClass = 'text-link underline decoration-link/30 underline-offset-4 hover:decoration-current';

/** What the visitor is in the middle of: each subject, and a smaller link to its reading progress. */
export function ContinueRow({ entries, locale }: { entries: ContinueEntry[]; locale: string }) {
  return (
    <>
      <h2 className="font-serif text-xl font-semibold tracking-tight">{m.home_continue_heading()}</h2>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {entries.map((entry) => {
          const label = pageText(entry.label, locale);
          return (
            <li
              key={entry.subjectId}
              className="flex min-w-0 flex-col gap-2 rounded-xl border border-border/70 bg-card p-3"
            >
              <a
                href={`/${locale}/subjects/${entry.subjectId}`}
                {...(label.lang ? { lang: label.lang } : {})}
                className={`${linkClass} font-medium break-words${label.text ? '' : ' text-muted-foreground'}`}
              >
                {label.text || m.subject_value_unlabelled()}
              </a>
              <a
                href={`/${locale}/library/progress?subjectId=${encodeURIComponent(entry.subjectId)}`}
                className={`${linkClass} text-sm`}
              >
                {m.home_continue_progress()}
              </a>
            </li>
          );
        })}
      </ul>
    </>
  );
}
