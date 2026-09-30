import { Badge } from '@rezics/ui/badge';
import { buttonVariants } from '@rezics/ui/button';
import { LocalizedText } from '@rezics/ui/localized-text';
import { BookCopyIcon } from 'lucide-react';
import type { UiLocale } from '../../i18n/define.ts';
import { contentText } from '../language/untagged.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import Link from '../shell/localized-link.tsx';
import { languageName } from '../work-page/format.ts';
import type { WorkPageMessages } from '../work-page/messages.ts';
import { Region, RegionFailure } from '../work-page/region.tsx';
import type { Copy } from './messages.ts';
import { NameLink } from './names.tsx';
import { anchors, editionsHref, type EditionsQuery, releaseHref } from './route.ts';
import type { Loaded, Names, Realization, RealizationPage, Release, ReleasePage } from './types.ts';

const outline = buttonVariants({ variant: 'outline', size: 'sm' });
const tag = 'rounded-sm bg-muted px-1.5 py-0.5 font-mono text-muted-foreground text-xs';

const kindLabel = (kind: Release['kind'], t: Copy) => ({ formal: t.kindFormal, web: t.kindWeb, fixed: t.kindFixed,
  virtual: t.kindVirtual })[kind];

const coverageLabel = (completeness: Release['coverage'][number]['completeness'], t: Copy) => ({
  complete: t.coverageComplete, partial: t.coveragePartial, trial: t.coverageTrial, unknown: t.coverageUnknown })[completeness];

/** A language tag named in the interface language, beside the tag itself so zh-Hant and zh-Hans are never confused. */
export function LanguageName({ tag: language, locale }: { tag: string; locale: UiLocale }) {
  return <span><span lang={locale}>{languageName(language, locale)}</span>{' '}<code className={tag}>{language}</code></span>;
}

function Status({ status, t }: { status: Release['status']; t: Copy }) {
  const label = { official: t.statusOfficial, unofficial: t.statusUnofficial, virtual: t.statusVirtual,
    withdrawn: t.statusWithdrawn, cancelled: t.statusCancelled }[status];
  return <Badge variant={status === 'official' ? 'soft' : 'outline'}>{label}</Badge>;
}

/** Where a realization's text comes from: another realization of the same Work, its Main Version, or nowhere known yet. */
function SourceContinuity({ realization, all, locale, t }: {
  realization: Realization; all: readonly Realization[]; locale: UiLocale; t: Copy;
}) {
  const source = realization.source;
  if (source.kind === 'unresolved') return <span>{t.continuityUnresolved}</span>;
  if (source.kind === 'main-version') return <span>{t.continuityMain}</span>;
  const from = all.find(item => item.id === source.realization);
  return from ? <span>{t.continuityFrom}{' '}<LanguageName tag={from.language} locale={locale} /></span>
    : <span>{t.continuityOther}</span>;
}

function Parties({ label, agents, names, t }: { label: string; agents: readonly string[]; names: Names; t: Copy }) {
  if (!agents.length) return null;
  return <div className="grid gap-0.5">
    <dt className="text-muted-foreground text-xs">{label}</dt>
    <dd className="flex flex-wrap gap-x-2 text-sm">{agents.map((agent, index) => <span key={agent}>{index ? '· ' : ''}
      <NameLink reference={agent} names={names} unavailable={t.unavailable} unnamed={t.unnamed} /></span>)}</dd>
  </div>;
}

/** One realization: who made this text and how far it can be trusted. */
export function RealizationRow({ realization, all, releases, names, locale, t }: {
  realization: Realization; all: readonly Realization[]; releases: readonly Release[]; names: Names; locale: UiLocale; t: Copy;
}) {
  const covering = releases.filter(release => release.coverage.some(entry => entry.realization === realization.id));
  const evidence = realization.evidence?.startsWith('https://') && !realization.evidence.startsWith('https://rezics.com/id/')
    ? realization.evidence : null;
  return <li id={`realization-${realization.id.slice(-12)}`} className="grid min-w-0 gap-3 border-border/70 border-b pb-4">
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="secondary">{realization.kind === 'original' ? t.kindOriginal : t.kindTranslation}</Badge>
      <Badge variant={realization.status === 'official' ? 'soft' : 'outline'}>
        {realization.status === 'official' ? t.statusOfficial : t.statusUnofficial}</Badge>
      <Badge variant={realization.verification === 'verified' ? 'soft' : 'outline'}>
        {realization.verification === 'verified' ? t.verified : t.unverified}</Badge>
    </div>
    <dl className="grid min-w-0 gap-3 sm:grid-cols-2">
      <div className="grid gap-0.5">
        <dt className="text-muted-foreground text-xs">{t.continuity}</dt>
        <dd className="text-sm"><SourceContinuity realization={realization} all={all} locale={locale} t={t} /></dd>
      </div>
      <Parties label={t.translators} agents={realization.translators} names={names} t={t} />
      <Parties label={t.publishers} agents={realization.publishers} names={names} t={t} />
      {evidence ? <div className="grid min-w-0 gap-0.5">
        <dt className="text-muted-foreground text-xs">{t.evidence}</dt>
        <dd className="min-w-0 text-sm"><a href={evidence} rel="noreferrer"
          className="break-all text-primary underline-offset-4 hover:underline">{evidence}</a></dd>
      </div> : null}
      {covering.length ? <div className="grid gap-0.5 sm:col-span-2">
        <dt className="text-muted-foreground text-xs">{t.releasesOfText}</dt>
        <dd className="flex flex-wrap gap-x-3 text-sm">{covering.map(release => <Link key={release.id}
          href={releaseHref(release.id)} className="rounded-sm text-primary underline-offset-4 hover:underline">
          <LocalizedText text={contentText(release.title.value, release.title.language)} /></Link>)}</dd>
      </div> : null}
    </dl>
  </li>;
}

/** Realizations gathered by the language and script they are written in: zh-Hant and zh-Hans stay apart. */
export function RealizationGroups({ realizations, releases, names, locale, t }: {
  realizations: readonly Realization[]; releases: readonly Release[]; names: Names; locale: UiLocale; t: Copy;
}) {
  const groups = new Map<string, Realization[]>();
  for (const realization of realizations) groups.set(realization.language, [...groups.get(realization.language) ?? [], realization]);
  return <div className="grid gap-6">
    {[...groups].map(([language, rows]) => <section key={language} aria-label={languageName(language, locale)}
      data-language-group={language} className="grid gap-3">
      <h3 className="font-semibold text-base"><LanguageName tag={language} locale={locale} /></h3>
      <ul className="grid gap-4">
        {rows.map(row => <RealizationRow key={row.id} realization={row} all={realizations} releases={releases}
          names={names} locale={locale} t={t} />)}
      </ul>
    </section>)}
  </div>;
}

function CoverageHeading({ level, children }: { level: 2 | 3 | 4; children: string }) {
  const Heading = `h${level}` as const;
  return <Heading className="font-medium text-sm">{children}</Heading>;
}

function ReleaseHeading({ level, release }: { level: 2 | 3; release: Release }) {
  const Heading = `h${level}` as const;
  return <Heading className="font-semibold text-base"><Link href={releaseHref(release.id)}
    className="rounded-sm underline-offset-4 hover:underline">
    <LocalizedText text={contentText(release.title.value, release.title.language)} as="span" /></Link></Heading>;
}

/** A release: its format, identifiers, platform, territory and what it covers; an omnibus lists every volume. */
export function ReleaseCard({ release, names, locale, t, headingLevel = 3, detailed = false }: {
  release: Release; names: Names; locale: UiLocale; t: Copy;
  /** Null when the page names the release itself (its own page). */
  headingLevel?: 2 | 3 | null; detailed?: boolean;
}) {
  const languages = release.contentLanguages.filter(language => language !== 'zxx');
  const identifiers = [...(release.isbn13 ? [{ provider: 'isbn', value: release.isbn13 }] : []),
    ...release.identifiers.filter(item => !(item.provider === 'isbn' && item.value === release.isbn13))];
  const works = [...new Set(release.coverage.map(entry => entry.work))];
  return <article id={`release-${release.id.slice(-12)}`} className="grid min-w-0 gap-3 border-border/70 border-b pb-5">
    <div className="grid min-w-0 gap-1">
      {headingLevel ? <ReleaseHeading level={headingLevel} release={release} /> : null}
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-sm">
        <span>{kindLabel(release.kind, t)}</span><Status status={release.status} t={t} />
        {release.publicationYear ? <span>{release.publicationYear}</span> : null}
        {release.publisher ? <span>{release.publisher}</span> : null}
        {release.editionStatement ? <span>{release.editionStatement}</span> : null}
      </p>
    </div>
    {release.status === 'withdrawn' ? <p role="note" className="text-muted-foreground text-sm">{t.withdrawnNotice}</p> : null}
    <dl className="grid min-w-0 gap-3 sm:grid-cols-2">
      {identifiers.length ? <div className="grid gap-0.5">
        <dt className="text-muted-foreground text-xs">{t.identifiers}</dt>
        <dd className="grid gap-0.5 text-sm">{identifiers.map(item => <span key={`${item.provider}:${item.value}`}>
          <span className="text-muted-foreground">{item.provider === 'isbn' ? t.isbn : item.provider}</span>{' '}
          {item.provider === 'isbn'
            ? <Link href={`/isbn/${item.value}`} className="font-mono underline-offset-4 hover:underline">{item.value}</Link>
            : <span className="font-mono">{item.value}</span>}</span>)}</dd>
      </div> : null}
      {release.platform ? <div className="grid gap-0.5">
        <dt className="text-muted-foreground text-xs">{t.platform}</dt><dd className="text-sm">{release.platform}</dd></div> : null}
      {release.territory ? <div className="grid gap-0.5">
        <dt className="text-muted-foreground text-xs">{t.territory}</dt><dd className="text-sm">{release.territory}</dd></div> : null}
      {languages.length ? <div className="grid gap-0.5">
        <dt className="text-muted-foreground text-xs">{t.languages}</dt>
        <dd className="flex flex-wrap gap-x-3 text-sm">{languages.map(language => <LanguageName key={language} tag={language}
          locale={locale} />)}</dd></div> : null}
      {release.originalUrl ? <div className="grid min-w-0 gap-0.5 sm:col-span-2">
        <dt className="text-muted-foreground text-xs">{t.originalUrl}</dt>
        <dd className="min-w-0 text-sm"><a href={release.originalUrl} rel="noreferrer"
          className="break-all text-primary underline-offset-4 hover:underline">{release.originalUrl}</a></dd></div> : null}
    </dl>
    {release.coverage.length ? <div className="grid gap-1">
      <CoverageHeading level={(headingLevel ?? 1) + 1 as 2 | 3 | 4}>{works.length > 1 ? t.coversWorks(works.length) : t.coverage}</CoverageHeading>
      <ul className="grid gap-1 text-sm">
        {release.coverage.map(entry => <li key={`${entry.work}-${entry.realization ?? ''}`}
          className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <NameLink reference={entry.work} names={names} unavailable={t.unavailable} unnamed={t.unnamed} />
          <span className="text-muted-foreground">{coverageLabel(entry.completeness, t)}</span>
          {entry.portion ? <span className="text-muted-foreground">· {entry.portion}</span> : null}
          {detailed && entry.language ? <LanguageName tag={entry.language} locale={locale} /> : null}
        </li>)}
      </ul>
    </div> : null}
    {release.snapshots.length ? <p className="text-muted-foreground text-sm">{t.snapshotCount(release.snapshots.length)}</p> : null}
  </article>;
}

function Pager({ label, first, next, t }: { label: string; first: string | null; next: string | null; t: Copy }) {
  if (!first && !next) return null;
  return <nav aria-label={label} className="flex flex-wrap justify-between gap-2">
    {first ? <Link href={first} className={outline}>{t.firstPage}</Link> : <span />}
    {next ? <Link href={next} className={outline}>{t.showMore}</Link> : null}
  </nav>;
}

/**
 * The Work's realizations, grouped by the language and script they are in, and its
 * releases, each with the facts that tell one edition from another. Both continue on
 * Main's cursors under their own anchors.
 */
export function EditionsSection({ realizations, releases, names, workRef, query, locale, t, pageMessages }: {
  realizations: Loaded<RealizationPage>; releases: Loaded<ReleasePage>; names: Names; workRef: string;
  query: EditionsQuery; locale: UiLocale; t: Copy; pageMessages: WorkPageMessages;
}) {
  const knownReleases = releases.ok ? releases.data.items : [];
  return <div className="grid gap-10">
    <Region id={anchors.realizations} title={t.realizations} className="scroll-mt-20">
      {!realizations.ok
        ? <RegionFailure title={t.realizationsUnavailable} failure={realizations.failure} messages={pageMessages}
          restartHref={editionsHref(workRef, { ...query, realizationsAfter: undefined }, anchors.realizations)} />
        : realizations.data.items.length
          ? <RealizationGroups realizations={realizations.data.items} releases={knownReleases} names={names} locale={locale} t={t} />
          : <EmptyState icon={BookCopyIcon} headingLevel={3} title={t.noRealizations} description={t.noRealizationsBody} />}
      {realizations.ok ? <Pager label={t.realizationsPages} t={t}
        first={query.realizationsAfter ? editionsHref(workRef, { ...query, realizationsAfter: undefined }, anchors.realizations) : null}
        next={realizations.data.nextCursor ? editionsHref(workRef, { ...query, realizationsAfter: realizations.data.nextCursor },
          anchors.realizations) : null} /> : null}
    </Region>
    <Region id={anchors.releases} title={t.releases} className="scroll-mt-20">
      {!releases.ok
        ? <RegionFailure title={t.releasesUnavailable} failure={releases.failure} messages={pageMessages}
          restartHref={editionsHref(workRef, { ...query, releasesAfter: undefined }, anchors.releases)} />
        : releases.data.items.length
          ? <div className="grid gap-5">{releases.data.items.map(release => <ReleaseCard key={release.id} release={release}
            names={names} locale={locale} t={t} />)}</div>
          : <EmptyState icon={BookCopyIcon} headingLevel={3} title={t.noReleases} description={t.noReleasesBody} />}
      {releases.ok ? <Pager label={t.releasesPages} t={t}
        first={query.releasesAfter ? editionsHref(workRef, { ...query, releasesAfter: undefined }, anchors.releases) : null}
        next={releases.data.nextCursor ? editionsHref(workRef, { ...query, releasesAfter: releases.data.nextCursor },
          anchors.releases) : null} /> : null}
    </Region>
  </div>;
}
