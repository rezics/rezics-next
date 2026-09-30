import { buttonVariants } from '@rezics/ui/button';
import { LocalizedText } from '@rezics/ui/localized-text';
import { ArrowRightIcon } from 'lucide-react';
import type { UiLocale } from '../../i18n/define.ts';
import { contentText } from '../language/untagged.ts';
import Link from '../shell/localized-link.tsx';
import type { WorkPageMessages } from '../work-page/messages.ts';
import { Region, RegionFailure } from '../work-page/region.tsx';
import { RelationRows } from './connections.tsx';
import { LanguageName } from './editions.tsx';
import type { Copy } from './messages.ts';
import { NameLink } from './names.tsx';
import { WholesLines } from './parts.tsx';
import { franchisesOf, relationRows } from './relation-rows.ts';
import { anchors, connectionsHref, editionsHref, releaseHref } from './route.ts';
import type { Loaded, Names, PartsPage, RealizationPage, RelationsPage, ReleasePage, WholesPage } from './types.ts';

// The previews a Work hub page and a franchise Zone embed: a few items of each
// level and one link into its full page. They take what Main answered, so the
// hub reads once and the stories need no server; `previews-server.tsx` reads
// for an embedder that has only a Work.

const more = `${buttonVariants({ variant: 'ghost', size: 'sm' })} w-fit`;

function ViewAll({ href, label }: { href: string; label: string }) {
  return <Link href={href} className={more}>{label}<ArrowRightIcon aria-hidden="true" /></Link>;
}

export const PREVIEW_COUNTS = { parts: 6, wholes: 3, relations: 8, realizations: 4, releases: 3 } as const;

/** The next few parts and the wholes that contain the Work, with a link to every part. */
export function PartsPreviewView({ parts, wholes, names, workRef, pageMessages, t }: {
  parts: Loaded<PartsPage>; wholes: Loaded<WholesPage> | null; names: Names; workRef: string;
  pageMessages: WorkPageMessages; t: Copy;
}) {
  if (!parts.ok) {
    return parts.failure === 'missing' ? null : <Region id="parts-preview" title={t.parts}>
      <RegionFailure title={t.partsUnavailable} failure={parts.failure} messages={pageMessages} /></Region>;
  }
  const shown = parts.data.parts.slice(0, PREVIEW_COUNTS.parts);
  const hasWholes = wholes?.ok && wholes.data.wholes.length > 0;
  if (!shown.length && !hasWholes) return null;
  return <Region id="parts-preview" title={t.parts}>
    <WholesLines wholes={wholes} names={names} t={t} />
    {shown.length ? <ol aria-label={t.partsList} className="grid gap-1.5">
      {shown.map(part => <li key={part.occurrence} className="flex min-w-0 flex-wrap items-baseline gap-x-3 text-sm">
        <span className="min-w-12 font-semibold tabular-nums">
          {part.displayLabel ? <LocalizedText text={contentText(part.displayLabel)} /> : null}</span>
        {part.work ? <NameLink reference={part.work} names={names} unavailable={t.unavailable} unnamed={t.unnamed} /> : null}
      </li>)}
    </ol> : null}
    <ViewAll href={connectionsHref(workRef, {}, anchors.parts)} label={t.allParts} />
  </Region>;
}

/** The first typed relations and the franchises that contain the Work. */
export function ConnectionsPreviewView({ relations, workRef, locale, pageMessages, t }: {
  relations: Loaded<RelationsPage>; workRef: string; locale: UiLocale;
  pageMessages: WorkPageMessages; t: Copy;
}) {
  if (!relations.ok) {
    return relations.failure === 'missing' ? null : <Region id="connections-preview" title={t.connections}>
      <RegionFailure title={t.connectionsUnavailable} failure={relations.failure} messages={pageMessages} /></Region>;
  }
  const rows = relationRows(relations.data.items).slice(0, PREVIEW_COUNTS.relations);
  const franchises = franchisesOf(relations.data.items);
  if (!rows.length && !franchises.length) return null;
  return <Region id="connections-preview" title={t.connections}>
    {franchises.length ? <p className="text-sm"><span className="text-muted-foreground">{t.franchises}</span>{' '}
      {franchises.map((franchise, index) => <span key={franchise.reference}>{index ? ', ' : ''}
        {franchise.status === 'available' ? <LocalizedText text={franchise.name} className="font-medium" />
          : <span className="text-muted-foreground">{t.unavailable}</span>}</span>)}</p> : null}
    {rows.length ? <RelationRows rows={rows} locale={locale} t={t} /> : null}
    <ViewAll href={connectionsHref(workRef, {}, anchors.relations)} label={t.allConnections} />
  </Region>;
}

/** The languages the Work is realized in and its first releases. */
export function EditionsPreviewView({ realizations, releases, workRef, locale, pageMessages, t }: {
  realizations: Loaded<RealizationPage>; releases: Loaded<ReleasePage>; workRef: string; locale: UiLocale;
  pageMessages: WorkPageMessages; t: Copy;
}) {
  const languages = realizations.ok ? [...new Set(realizations.data.items.map(item => item.language))] : [];
  const listed = releases.ok ? releases.data.items.slice(0, PREVIEW_COUNTS.releases) : [];
  const failure = !realizations.ok ? realizations.failure : !releases.ok ? releases.failure : null;
  if (failure && failure !== 'missing') {
    return <Region id="editions-preview" title={t.editions}>
      <RegionFailure title={t.editionsUnavailable} failure={failure} messages={pageMessages} /></Region>;
  }
  if (!languages.length && !listed.length) return null;
  return <Region id="editions-preview" title={t.editions}>
    {languages.length ? <ul aria-label={t.realizations} className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
      {languages.map(language => <li key={language}><LanguageName tag={language} locale={locale} /></li>)}</ul> : null}
    {listed.length ? <ul aria-label={t.releases} className="grid gap-1.5 text-sm">
      {listed.map(release => <li key={release.id} className="flex flex-wrap items-baseline gap-x-2">
        <Link href={releaseHref(release.id)} className="font-medium underline-offset-4 hover:underline">
          <LocalizedText text={contentText(release.title.value, release.title.language)} /></Link>
        {release.publicationYear ? <span className="text-muted-foreground">{release.publicationYear}</span> : null}
      </li>)}</ul> : null}
    <ViewAll href={editionsHref(workRef, {}, anchors.realizations)} label={t.allEditions} />
  </Region>;
}
