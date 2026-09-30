import { Badge } from '@rezics/ui/badge';
import { buttonVariants } from '@rezics/ui/button';
import { LocalizedText } from '@rezics/ui/localized-text';
import { FolderOpenIcon, LayersIcon } from 'lucide-react';
import type { UiLocale } from '../../i18n/define.ts';
import { contentText } from '../language/untagged.ts';
import Link from '../shell/localized-link.tsx';
import type { WorkPageMessages } from '../work-page/messages.ts';
import { Region, RegionFailure } from '../work-page/region.tsx';
import { EmptyState } from '../shell/empty-state.tsx';
import type { Copy } from './messages.ts';
import { NameLink } from './names.tsx';
import { anchors, connectionsHref, type ConnectionsQuery } from './route.ts';
import type { Loaded, Names, Part, PartsPage, WholesPage } from './types.ts';

const outline = buttonVariants({ variant: 'outline', size: 'sm' });

/** The label a part carries in this Work's numbering ("22 Reverse", "SS1"); the part's own name follows it. */
function PartLabel({ part }: { part: Part }) {
  const recorded = part.labels[0];
  if (part.displayLabel) return <LocalizedText text={contentText(part.displayLabel)} />;
  return recorded ? <LocalizedText text={contentText(recorded.value, recorded.language)} /> : null;
}

/** The `Part of` lines: one per whole that places this Work, each a link to it. */
export function WholesLines({ wholes, names, t }: { wholes: Loaded<WholesPage> | null; names: Names; t: Copy }) {
  if (!wholes?.ok || !wholes.data.wholes.length) return null;
  return <ul id={anchors.wholes} aria-label={t.partOfList} className="grid scroll-mt-20 gap-1">
    {wholes.data.wholes.map(whole => <li key={whole.occurrence} className="text-sm">
      <span className="text-muted-foreground">{t.partOf}</span>{' '}
      <NameLink reference={whole.work} names={names} unavailable={t.unavailable} unnamed={t.unnamed} />
    </li>)}
  </ul>;
}

/** What the Work's own Structure says about its run, as Main evidences it. */
function Completion({ completion, t }: { completion: PartsPage['completion']; t: Copy }) {
  const label = completion.status === 'concluded' ? t.completionConcluded
    : completion.status === 'ongoing' ? t.completionOngoing : t.completionUnknown;
  const evidence = completion.evidence.filter(item => /^https?:\/\//.test(item));
  return <p className="text-muted-foreground text-sm">{label}
    {evidence.map((href, index) => <span key={href}>{index ? ', ' : ' · '}<a href={href} rel="noreferrer"
      className="break-all text-primary underline-offset-4 hover:underline">{t.evidence}{evidence.length > 1 ? ` ${index + 1}` : ''}</a></span>)}
  </p>;
}

function PartRow({ part, names, workRef, query, t }: {
  part: Part; names: Names; workRef: string; query: ConnectionsQuery; t: Copy;
}) {
  const inclusion = part.inclusion === 'optional' ? t.inclusionOptional : part.inclusion === 'extra' ? t.inclusionExtra : null;
  return <li id={`part-${part.occurrence.slice(-12)}`}
    className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 py-3">
    <span className="min-w-14 font-semibold tabular-nums"><PartLabel part={part} /></span>
    <span className="min-w-0 flex-1">
      {part.work ? <NameLink reference={part.work} names={names} unavailable={t.unavailable} unnamed={t.unnamed} />
        : <Link href={connectionsHref(workRef, { ...query, parent: part.occurrence.slice(-36), partsAfter: undefined },
          anchors.parts)} className={outline}><FolderOpenIcon aria-hidden="true" />{t.openGroup}</Link>}
    </span>
    {inclusion ? <Badge variant="outline">{inclusion}</Badge> : null}
  </li>;
}

/**
 * The Work's ordered parts in the order Main keeps them (publication order), each with
 * its local label and inclusion, and the wholes that contain the Work. A group opens
 * in place by URL; "Show more" continues Main's cursor and never re-derives order.
 */
export function PartsSection({ parts, wholes, names, workRef, query, locale: _locale, t, pageMessages }: {
  parts: Loaded<PartsPage>; wholes: Loaded<WholesPage> | null; names: Names; workRef: string;
  query: ConnectionsQuery; locale: UiLocale; t: Copy; pageMessages: WorkPageMessages;
}) {
  const first = connectionsHref(workRef, { ...query, partsAfter: undefined }, anchors.parts);
  const body = !parts.ok
    ? <RegionFailure title={t.partsUnavailable} failure={parts.failure} messages={pageMessages} restartHref={first} />
    : <>
      <WholesLines wholes={wholes} names={names} t={t} />
      <Completion completion={parts.data.completion} t={t} />
      {query.parent ? <Link href={connectionsHref(workRef, { ...query, parent: undefined, partsAfter: undefined },
        anchors.parts)} className={`${outline} w-fit`}>{t.allParts}</Link> : null}
      {parts.data.parts.length
        ? <ol aria-label={t.partsList} className="grid divide-y divide-border/60 border-border/60 border-y">
          {parts.data.parts.map(part => <PartRow key={part.occurrence} part={part} names={names} workRef={workRef}
            query={query} t={t} />)}
        </ol>
        : <EmptyState icon={LayersIcon} headingLevel={3} title={t.noParts} description={t.noPartsBody} />}
      {query.partsAfter || parts.data.next
        ? <nav aria-label={t.partsPages} className="flex flex-wrap justify-between gap-2">
          {query.partsAfter ? <Link href={first} className={outline}>{t.firstPage}</Link> : <span />}
          {parts.data.next ? <Link href={connectionsHref(workRef, { ...query, partsAfter: parts.data.next },
            anchors.parts)} className={outline}>{t.showMore}</Link> : null}
        </nav> : null}
    </>;
  return <Region id={anchors.parts} title={t.parts} className="scroll-mt-20">{body}</Region>;
}
