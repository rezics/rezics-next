import { LocalizedText } from '@rezics/ui/localized-text';
import Link from '../shell/localized-link.tsx';
import { workLinkHref } from './route.ts';
import type { AvailableSummary, Names, NameText, Summary } from './types.ts';

/** Where a named resource's page is; null when it has none to link. Works link to their own host by default. */
export type SummaryHref = (summary: AvailableSummary) => string | null;

const link = 'rounded-sm font-medium outline-none decoration-1 underline-offset-4 hover:underline '
  + 'focus-visible:ring-2 focus-visible:ring-ring';

/** What Main named a resource: its name in the language Main selected, or null when it is unavailable or unnamed. */
export function nameOf(names: Names, reference: string): NameText | null {
  const summary: Summary | undefined = names.get(reference);
  return summary?.status === 'available' ? summary.name : null;
}

/**
 * A resource's name as a link when it is a Work. Each name keeps its own
 * `lang` and `dir` inside `bdi`, so its direction never reorders the words
 * around it. A resource Main will not name says so, which is not the same
 * as a name nobody has recorded.
 */
export function SummaryLink({ summary, unavailable, unnamed, hrefFor }: {
  summary: Summary | null | undefined; unavailable: string; unnamed: string; hrefFor?: SummaryHref;
}) {
  if (!summary) return <span className="text-muted-foreground">{unnamed}</span>;
  if (summary.status !== 'available') return <span className="text-muted-foreground">{unavailable}</span>;
  const href = hrefFor ? hrefFor(summary) : summary.type === 'work' ? workLinkHref(summary.reference) : null;
  const text = <LocalizedText text={summary.name} />;
  return href ? <Link href={href} className={link}>{text}</Link> : <span className="font-medium">{text}</span>;
}

/** `SummaryLink` for a resource named by a batch read. */
export function NameLink({ reference, names, unavailable, unnamed }: {
  reference: string; names: Names; unavailable: string; unnamed: string;
}) {
  return <SummaryLink summary={names.get(reference)} unavailable={unavailable} unnamed={unnamed} />;
}
