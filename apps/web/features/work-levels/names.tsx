import type { CanonicalAddress } from '@rezics/model/address';
import { LocalizedText } from '@rezics/ui/localized-text';
import Link from '../shell/localized-link.tsx';
import { resourceHref } from '../address/path.ts';
import { workLinkHref } from './route.ts';
import { NameRecovery } from './name-recovery.tsx';
import type { AvailableSummary, Names, NameText, NameSummary } from './types.ts';

/** Where a named resource's page is; null when it has none to link. Works link to their own host by default. */
export type SummaryHref = (summary: AvailableSummary) => string | null;

const link = 'rounded-sm font-medium outline-none decoration-1 underline-offset-4 hover:underline '
  + 'focus-visible:ring-2 focus-visible:ring-ring';

/**
 * Use Main's canonical address so following a relation needs no address redirect.
 */
export const summaryWorkHref = (summary: AvailableSummary): string | null =>
  summary.type === 'work' ? resourceHref('/w/', summary.address as CanonicalAddress) : null;

/** `summaryWorkHref` for a Work named by a batch read, falling back to its identity when Main named nothing. */
export function namedWorkHref(reference: string, names: Names): string | null {
  const summary = names.get(reference);
  return summary?.status === 'available' && summary.type === 'work' ? summaryWorkHref(summary) : workLinkHref(reference);
}

/** A disclosed native name or an authored public vocabulary label, retaining its content language. */
export function nameOf(names: Names, reference: string): NameText | null {
  const summary = names.get(reference);
  return summary?.status === 'available' || summary?.status === 'public-term' ? summary.name : null;
}

/**
 * A resource's name as a link when it is a Work. Each name keeps its own
 * `lang` and `dir` inside `bdi`, so its direction never reorders the words
 * around it. A resource Main will not name says so, which is not the same
 * as a name nobody has recorded.
 */
export function SummaryLink({ summary, unavailable, unnamed, undisclosed = unavailable, hrefFor }: {
  summary: NameSummary | null | undefined; unavailable: string; unnamed: string;
  undisclosed?: string; hrefFor?: SummaryHref;
}) {
  let content;
  if (!summary || summary.status === 'unavailable-read') content = <span data-name-state="unavailable" className="text-muted-foreground">{unavailable}</span>;
  else if (summary.status === 'public-term') content = <span className="font-medium"><LocalizedText text={summary.name} /></span>;
  else if (summary.status !== 'available') content = <span data-name-state="undisclosed" className="text-muted-foreground">{undisclosed}</span>;
  else {
    const href = hrefFor ? hrefFor(summary) : summaryWorkHref(summary);
    const text = summary.name.value ? <LocalizedText text={summary.name} /> : <span data-name-state="unnamed">{unnamed}</span>;
    // A Work hub streams independent reads. Its RSC response can stay open while
    // the client router keeps the old Work; the browser can commit the document as it streams.
    content = href ? <Link href={href} documentNavigation={summary.type === 'work'} className={link}>{text}</Link>
      : <span className="font-medium">{text}</span>;
  }
  return <NameRecovery status={summary?.status ?? 'unavailable-read'}>{content}</NameRecovery>;
}

/** `SummaryLink` for a resource named by a batch read. */
export function NameLink({ reference, names, unavailable, unnamed, undisclosed }: {
  reference: string; names: Names; unavailable: string; unnamed: string; undisclosed?: string;
}) {
  return <SummaryLink summary={names.get(reference)} unavailable={unavailable} unnamed={unnamed} undisclosed={undisclosed} />;
}
