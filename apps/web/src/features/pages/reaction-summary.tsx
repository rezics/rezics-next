import { m } from '../../paraglide/messages.js';
import { useSearchRetryWait } from '../../search/search-recovery-retry';
import { OverviewContext } from './overview-context';
import { nativeReactionSummaryPage, plannedReactionRead, subjectReactionKinds } from './reaction-page-admission';
import { linkClass, linkColor } from './shared';
import { useContext } from 'react';

const controlClass = `${linkClass} ${linkColor} inline-flex min-h-[44px] min-w-[44px] max-w-full items-center rounded-sm px-2 py-2 text-start whitespace-normal [overflow-wrap:anywhere] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`;
const labels = {
  like: (locale: string) => m.reaction_like({}, { locale: locale as never }),
  love: (locale: string) => m.reaction_love({}, { locale: locale as never }),
  laugh: (locale: string) => m.reaction_laugh({}, { locale: locale as never }),
  insightful: (locale: string) => m.reaction_insightful({}, { locale: locale as never }),
  sad: (locale: string) => m.reaction_sad({}, { locale: locale as never }),
} as const;

/** Public totals from the planned reactions leaf. Viewer reaction stays on the header actions slot. */
export function ReactionSummary(props: Record<string, unknown>) {
  const value = useContext(OverviewContext);
  const id = String(props.id);
  const section = value?.sections.get(id);
  const retryWaiting = useSearchRetryWait(section && !section.ok ? section.retryAt : undefined);
  if (!value) return null;
  if (section && !section.ok && section.status === 204) return null;
  const options = { locale: value.locale as never };
  const page =
    section?.ok && plannedReactionRead(section.read, value.subject)
      ? nativeReactionSummaryPage(section.read, section.body)
      : undefined;
  const retryHref = value.currentHref;
  return (
    <section data-slot="reaction-summary" aria-labelledby={`${id}-title`} className="min-w-0 space-y-3">
      <h2 id={`${id}-title`} className="text-xl font-semibold tracking-tight [overflow-wrap:anywhere]">
        {m.reaction_reactions({}, options)}
      </h2>
      {!page ? (
        <p role="alert" className="[overflow-wrap:anywhere]">
          {m.subject_reactions_unavailable({}, options)}{' '}
          {retryHref &&
            (retryWaiting ? (
              <button
                type="button"
                disabled
                className={`${controlClass} disabled:cursor-not-allowed disabled:opacity-60`}
              >
                {m.subject_section_retry({}, options)}
              </button>
            ) : (
              <a href={retryHref} className={controlClass}>
                {m.subject_section_retry({}, options)}
              </a>
            ))}
        </p>
      ) : (
        <ReactionTotals locale={value.locale} counts={page.counts} />
      )}
    </section>
  );
}

function ReactionTotals({
  locale,
  counts,
}: {
  locale: string;
  counts: Partial<Record<(typeof subjectReactionKinds)[number], number>>;
}) {
  const options = { locale: locale as never };
  const format = (value: number) => new Intl.NumberFormat(locale).format(value);
  const entries = subjectReactionKinds.flatMap((kind) => {
    const count = counts[kind];
    return count === undefined ? [] : [[kind, count] as const];
  });
  if (!entries.length) return <p role="status">{m.subject_community_reactions_none({}, options)}</p>;
  return (
    <ul aria-label={m.reaction_reactions({}, options)} className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
      {entries.map(([kind, count]) => (
        <li key={kind}>{`${labels[kind](locale)} ${format(count)}`}</li>
      ))}
    </ul>
  );
}
