import { Badge } from '@rezics/ui/badge';
import { buttonVariants } from '@rezics/ui/button';
import { LocalizedText } from '@rezics/ui/localized-text';
import { cn } from '@rezics/ui/utils';
import { LinkIcon, NetworkIcon } from 'lucide-react';
import type { UiLocale } from '../../i18n/define.ts';
import { resourceHref } from '../address/path.ts';
import { authorHref } from '../author/route.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import Link from '../shell/localized-link.tsx';
import { languageName } from '../work-page/format.ts';
import type { WorkPageMessages } from '../work-page/messages.ts';
import { Region, RegionFailure } from '../work-page/region.tsx';
import type { Copy } from './messages.ts';
import { NameLink, SummaryLink, type SummaryHref } from './names.tsx';
import { type Appearance, type CreditedName, labelFor, type RelationItem, type RelationRow, relationRows } from './relation-rows.ts';
import { anchors, connectionsHref, type ConnectionsQuery, type Grain, grains, workLinkHref } from './route.ts';
import type { CollectionMembers, Loaded, Names, PartsPage, People, RelationsPage, Summary } from './types.ts';

const outline = buttonVariants({ variant: 'outline', size: 'sm' });

/** A franchise Collection, its members in Main's order, and at the parts grain each member's parts. */
export interface Franchise {
  collection: Summary;
  members: Loaded<CollectionMembers>;
  /** Parts per member Work, read only at the parts grain and only for the first members. */
  parts: ReadonlyMap<string, Loaded<PartsPage>>;
}

function Participant({ item, t, hrefFor, people }: { item: RelationItem; t: Copy; hrefFor?: SummaryHref; people?: People }) {
  const target = item.target;
  if (target.kind === 'withheld') return <span className="text-muted-foreground">{t.unavailable}</span>;
  if (target.kind === 'external') {
    // A contributor is one REZICS Agent wherever they are named: the link is their profile, not a page of this Zone.
    const person = target.agent ? people?.get(target.agent) : undefined;
    return person && target.agent
      ? <Link href={authorHref({ kind: 'agent', handle: person.handle, agent: target.agent })}
        title={person.handle ? `@${person.handle}` : undefined} data-contributor={target.agent}
        className="rounded-sm font-medium outline-none decoration-1 underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring">
        {person.name}</Link>
      : <bdi className="font-mono text-sm">{target.label}</bdi>;
  }
  return <SummaryLink summary={target.summary} unavailable={t.unavailable} unnamed={t.unnamed} hrefFor={hrefFor} />;
}

/** Where a withheld credit can be read: the participant's own page, never the reference written out. */
function creditPage(reference: string, item: RelationItem, hrefFor?: SummaryHref, people?: People): string {
  const person = people?.get(reference);
  if (person) return authorHref({ kind: 'agent', handle: person.handle, agent: reference });
  const targets = [item.target, ...(item.appearance?.alongside.map(part => part.target) ?? [])];
  for (const target of targets) {
    if (target.kind !== 'resource' || target.reference !== reference || target.summary?.status !== 'available') continue;
    const summary = target.summary;
    if (summary.type === 'agent') return authorHref({ kind: 'agent', handle: null, agent: reference });
    const href = hrefFor?.(summary) ?? (summary.type === 'work' ? workLinkHref(summary.reference) : null);
    if (href) return href;
  }
  return resourceHref('/e/', reference);
}

const creditLink = 'rounded-sm underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** A credited name beside its role: the recorded words, or a neutral label linked to where they may be read. */
function CreditedAs({ credit, item, t, hrefFor, people }: {
  credit: CreditedName; item: RelationItem; t: Copy; hrefFor?: SummaryHref; people?: People;
}) {
  if ('status' in credit) {
    return <span data-credited-name data-credited-unavailable className="text-muted-foreground">{t.creditedAs}{' '}
      <Link href={creditPage(credit.reference, item, hrefFor, people)} className={creditLink}>{t.nameNotShown}</Link></span>;
  }
  return <span data-credited-name className="text-muted-foreground">{t.creditedAs}{' '}
    <bdi lang={credit.language} dir="auto">{credit.lexical}</bdi></span>;
}

/** A lexical credit that repeats the name already shown adds nothing; a withheld credit always says so. */
function shownCredit(credit: CreditedName | undefined, visibleName: string | null): CreditedName | undefined {
  if (!credit) return undefined;
  if ('status' in credit) return credit;
  return visibleName !== null && credit.lexical !== visibleName ? credit : undefined;
}

/** What else the occurrence names beside its Work, such as the role the subject had there, and the name credited for it. */
function Alongside({ appearance, item, t, hrefFor, people, locale }: {
  appearance: Appearance; item: RelationItem; t: Copy; hrefFor?: SummaryHref; people?: People; locale: UiLocale;
}) {
  return <>
    {appearance.alongside.map((part, index) => <span key={index} data-appearance-part className="inline-flex min-w-0 items-baseline gap-x-1">
      <span aria-hidden="true" className="text-muted-foreground">·</span>
      <span className="sr-only"><RowLabel label={part.label} locale={locale} t={t} /></span>
      <Participant item={{ relation: '', target: part.target, unresolvedSource: false, evidence: null }} t={t}
        hrefFor={hrefFor} people={people} />
    </span>)}
    {appearance.creditedName ? <CreditedAs credit={appearance.creditedName} item={item} t={t} hrefFor={hrefFor} people={people} /> : null}
  </>;
}

function Target(props: { item: RelationItem; t: Copy; hrefFor?: SummaryHref; people?: People; locale: UiLocale }) {
  const { item, t, people, locale } = props;
  const name = item.target.kind === 'resource' && item.target.summary?.status === 'available'
    ? item.target.summary.name.value : item.target.kind === 'external'
      ? (item.target.agent ? people?.get(item.target.agent)?.name : undefined) ?? item.target.label : null;
  const credited = shownCredit(item.creditedName, name);
  return <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1">
    <Participant item={item} t={t} hrefFor={props.hrefFor} people={people} />
    {item.appearance ? <Alongside appearance={item.appearance} item={item} t={t} hrefFor={props.hrefFor} people={people} locale={locale} /> : null}
    {credited ? <CreditedAs credit={credited} item={item} t={t} hrefFor={props.hrefFor} people={people} /> : null}
  </span>;
}

/** The mark a derivation carries when its source's Main Version is not pinned: the link is known, its version is not. */
function Unresolved({ item, t }: { item: RelationItem; t: Copy }) {
  return item.unresolvedSource
    ? <Badge variant="outline" title={t.unresolvedHint}><LinkIcon aria-hidden="true" />{t.unresolvedSource}</Badge> : null;
}

/** Main's label, in its own language and direction, with a quiet note when it is not in the language asked for. */
function RowLabel({ label, locale, t }: { label: RelationRow['label']; locale: UiLocale; t: Copy }) {
  if (!label.text) return <span>{t.relatedFallback}</span>;
  return <span><LocalizedText text={label.text} />
    {label.fallbackLanguage
      ? <span className="ms-1 font-normal text-muted-foreground text-xs">{t.labelIn({ language: languageName(label.fallbackLanguage, locale) })}</span>
      : null}</span>;
}

/**
 * Every label and counterpart here is Main's: the row's heading is the label
 * Main selected (plural form and all), each name keeps its own language and
 * direction. Relations to Works read as rows, relations to people or
 * characters as role chips; neither is built by joining words around a name.
 */
export function RelationRows({ rows, locale, t, hrefFor, people }: { rows: readonly RelationRow[]; locale: UiLocale; t: Copy;
  /** Where a counterpart's page is, for a surface that hosts resources itself (a Zone). */
  hrefFor?: SummaryHref;
  /** The contributors the rows name, by Agent, so each links to its profile. */
  people?: People }) {
  const listed = rows.filter(row => row.style === 'row');
  const chips = rows.filter(row => row.style === 'chips');
  return <div className="grid gap-5">
    {listed.length ? <dl aria-label={t.relationsList} className="grid gap-4">
      {listed.map(row => <div key={row.key} data-relation-row className="grid gap-1 sm:grid-cols-[minmax(9rem,14rem)_1fr] sm:gap-4">
        <dt className="font-medium text-muted-foreground text-sm"><RowLabel label={row.label} locale={locale} t={t} /></dt>
        <dd className="grid min-w-0 gap-1">
          <ul className="grid gap-1">
            {row.items.map((item, index) => <li key={`${item.relation}-${index}`}
              className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <Target item={item} t={t} hrefFor={hrefFor} people={people} locale={locale} /><Unresolved item={item} t={t} />
            </li>)}
          </ul>
        </dd>
      </div>)}
    </dl> : null}
    {chips.length ? <ul aria-label={t.rolesList} className="flex flex-wrap gap-2">
      {chips.flatMap(row => row.items.map((item, index) => <li key={`${row.key}-${item.relation}-${index}`} data-role-chip
        className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5 rounded-xl border border-border/70 px-3 py-1 text-sm">
        {row.projection.toRole === 'character' && ['work', 'occurrence'].includes(row.projection.fromRole)
          && !(item.creditedName && 'status' in item.creditedName) ? null
          : <span className="text-muted-foreground"><RowLabel label={labelFor(row.projection, 1)} locale={locale} t={t} /></span>}
        <Target item={item} t={t} hrefFor={hrefFor} people={people} locale={locale} />
      </li>))}
    </ul> : null}
  </div>;
}

function GrainSwitch({ workRef, query, t }: { workRef: string; query: ConnectionsQuery; t: Copy }) {
  const label: Record<Grain, string> = { series: t.grainSeries, parts: t.grainParts };
  return <nav aria-label={t.grainSwitch} className="flex flex-wrap items-center gap-2">
    <span className="text-muted-foreground text-sm">{t.grainLabel}</span>
    <div role="group" aria-label={t.grainSwitch} className="inline-flex rounded-lg border border-border/80 p-0.5">
      {grains.map(grain => <Link key={grain} scroll={false} aria-current={query.grain === grain ? 'true' : undefined}
        href={connectionsHref(workRef, { ...query, grain, membersAfter: undefined }, anchors.franchises)}
        className={cn('rounded-md px-3 py-1 font-medium text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
          query.grain === grain ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}>
        {label[grain]}</Link>)}
    </div>
  </nav>;
}

function Members({ franchise, current, names, workRef, query, t }: {
  franchise: Franchise; current: string; names: Names; workRef: string; query: ConnectionsQuery; t: Copy;
}) {
  const members = franchise.members;
  if (!members.ok) return <p role="status" className="text-muted-foreground text-sm">{t.membersUnavailable}</p>;
  if (!members.data.members.length) return <p className="text-muted-foreground text-sm">{t.noMembers}</p>;
  const id = franchise.collection.reference.slice(-36);
  return <div className="grid gap-2">
    <ol aria-label={query.grain === 'parts' ? t.grainParts : t.grainSeries} className="grid gap-2">
      {members.data.members.map(member => {
        const work = member.target!;
        const parts = franchise.parts.get(work);
        return <li key={member.occurrence} className="grid min-w-0 gap-1"
          aria-current={work.endsWith(current) ? 'true' : undefined}>
          <span className="flex flex-wrap items-center gap-2">
            <NameLink reference={work} names={names} unavailable={t.unavailable} unnamed={t.unnamed} />
            {work.endsWith(current) ? <Badge variant="soft">{t.thisWork}</Badge> : null}
          </span>
          {query.grain === 'parts' && parts
            ? parts.ok
              ? <ol className="ms-4 flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground text-sm">
                {parts.data.parts.filter(part => part.work).map(part => <li key={part.occurrence} className="whitespace-nowrap">
                  <NameLink reference={part.work!} names={names} unavailable={t.unavailable} unnamed={t.unnamed} />
                  {part.displayLabel ? <> <bdi className="tabular-nums">({part.displayLabel})</bdi></> : null}
                </li>)}
                {parts.data.next && workLinkHref(work) ? <li><Link href={`${workLinkHref(work)}/connections#parts`}
                  className="text-primary underline-offset-4 hover:underline">{t.morePartsExist}</Link></li> : null}
              </ol>
              : parts.failure === 'missing' ? null
                : <span className="ms-4 text-muted-foreground text-sm">{t.partsUnavailable}</span>
            : null}
        </li>;
      })}
    </ol>
    {members.data.next ? <Link className={`${outline} w-fit`} scroll={false}
      href={connectionsHref(workRef, { ...query, franchise: id, membersAfter: members.data.next }, anchors.franchises)}>
      {t.showMore}</Link> : null}
  </div>;
}

function Franchises({ franchises, names, workRef, current, query, t }: {
  franchises: readonly Franchise[]; names: Names; workRef: string; current: string; query: ConnectionsQuery; t: Copy;
}) {
  if (!franchises.length) return null;
  return <div id={anchors.franchises} className="grid scroll-mt-20 gap-3">
    <h3 className="font-semibold text-base">{t.franchises}</h3>
    <GrainSwitch workRef={workRef} query={query} t={t} />
    {franchises.map(franchise => {
      const summary = franchise.collection;
      return <section key={summary.reference} aria-label={summary.status === 'available' ? summary.name.value : t.unavailable}
        className="grid gap-2 rounded-xl border border-border/70 p-4">
        <h4 className="font-medium">{summary.status === 'available'
          ? <LocalizedText text={summary.name} /> : <span className="text-muted-foreground">{t.unavailable}</span>}</h4>
        <Members franchise={franchise} current={current} names={names} workRef={workRef} query={query} t={t} />
      </section>;
    })}
  </div>;
}

/**
 * Typed relations in both directions, the franchises (Collections) that contain
 * the Work with their series ⇄ parts grain, and Main's continuation of both.
 */
export function ConnectionsSection({ relations, franchises, names, people, workRef, current, query, locale, t, pageMessages }: {
  relations: Loaded<RelationsPage>; franchises: readonly Franchise[]; names: Names; people?: People; workRef: string;
  /** The Work's UUID, to mark it among its franchise's members. */
  current: string; query: ConnectionsQuery; locale: UiLocale; t: Copy; pageMessages: WorkPageMessages;
}) {
  const first = connectionsHref(workRef, { ...query, relationsAfter: undefined }, anchors.relations);
  if (!relations.ok) {
    return <Region id={anchors.relations} title={t.connections} className="scroll-mt-20">
      <RegionFailure title={t.connectionsUnavailable} failure={relations.failure} messages={pageMessages} restartHref={first} />
    </Region>;
  }
  const rows = relationRows(relations.data.items);
  const empty = !rows.length && !franchises.length;
  return <Region id={anchors.relations} title={t.connections} className="scroll-mt-20">
    {empty
      ? <EmptyState icon={NetworkIcon} headingLevel={3} title={t.noConnections} description={t.noConnectionsBody} />
      : <>
        <Franchises franchises={franchises} names={names} workRef={workRef} current={current} query={query} t={t} />
        {rows.length ? <RelationRows rows={rows} locale={locale} t={t} people={people} /> : null}
      </>}
    {query.relationsAfter || relations.data.next
      ? <nav aria-label={t.relationsPages} className="flex flex-wrap justify-between gap-2">
        {query.relationsAfter ? <Link href={first} className={outline}>{t.firstPage}</Link> : <span />}
        {relations.data.next ? <Link href={connectionsHref(workRef, { ...query, relationsAfter: relations.data.next },
          anchors.relations)} className={outline}>{t.showMore}</Link> : null}
      </nav> : null}
  </Region>;
}
