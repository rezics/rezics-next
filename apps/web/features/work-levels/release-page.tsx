import { LocalizedText } from '@rezics/ui/localized-text';
import { buttonVariants } from '@rezics/ui/button';
import type { UiLocale } from '../../i18n/define.ts';
import { contentText } from '../language/untagged.ts';
import { messages as workMessages, type WorkPageMessages } from '../work-page/messages.ts';
import { Region, RegionFailure } from '../work-page/region.tsx';
import { SubjectHeader } from '../entity-page/header.tsx';
import { sourceHref, SubjectSources } from '../entity-page/sources.tsx';
import { copyOf as detailCopy } from '../entity-page/messages.ts';
import { ReportMenu } from '../safety/report-action.tsx';
import Link from '../shell/localized-link.tsx';
import { coverageLabel, LanguageName, RealizationRow, ReleaseCard } from './editions.tsx';
import type { Copy } from './messages.ts';
import { NameLink } from './names.tsx';
import type { SelectedRealizationRead } from './read.ts';
import type { Loaded, Names, Realization, Release } from './types.ts';

/**
 * A release with what it reaches: for each thing it covers, the Work, its Main Version and
 * the realization (who made that text) it carries. Everything comes from Main's release
 * coverage; nothing is matched by title.
 */
export function ReleaseView({ release, realizations, sources, sourceReads = [], names, locale, t }: {
  release: Release; realizations: ReadonlyMap<string, Loaded<Realization>>;
  /** The realizations those ones follow, so a translation can name the language it comes from. */
  sources: readonly Realization[]; sourceReads?: readonly SelectedRealizationRead[];
  names: Names; locale: UiLocale; t: Copy;
}) {
  const loaded = [...[...realizations.values()].flatMap(item => (item.ok ? [item.data] : [])), ...sources];
  // Identity/revision survives absent evidence; distinct retained revisions stay distinct.
  const records = [...new Map(loaded.map(item => [`${item.id}\0${item.revision}`, item] as const)).values()];
  const original = sourceHref(release.originalUrl);
  const detail = detailCopy(locale);
  return <div className="grid gap-8">
    <SubjectHeader identity={<div className="grid gap-1.5">
      <p className="text-muted-foreground text-sm">{t.release}</p>
      <h1 className="font-semibold text-2xl tracking-tight [overflow-wrap:anywhere] sm:text-3xl">
        <LocalizedText text={contentText(release.title.value, release.title.language)} as="span" /></h1>
    </div>}
      primary={<>
        {release.coverage.length ? <Link href="#covers" className={buttonVariants({ size: 'sm' })}>{t.coversHeading}</Link> : null}
        {original ? <a href={original} rel="noreferrer noopener" className={buttonVariants({ size: 'sm', variant: 'outline' })}>{t.openPublication}</a> : null}
      </>}
      actions={<ReportMenu targets={[{ target: release.id, kind: 'page' }]} name={release.title.value} locale={locale} />} />
    <ReleaseCard release={release} names={names} locale={locale} t={t} headingLevel={null} detailed coverage={false} showOriginalUrl={false} />
    <Region id="covers" title={t.coversHeading} className="scroll-mt-20">
      {release.coverage.length ? <ol className="grid gap-5">
        {release.coverage.map(entry => {
          const realization = entry.realization ? realizations.get(entry.realization) : undefined;
          return <li key={`${entry.work}-${entry.realization ?? ''}`} data-coverage className="grid min-w-0 gap-2 border-border/70 border-b pb-4">
            <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-medium"><NameLink reference={entry.work} names={names} unavailable={t.unavailable} unnamed={t.unnamed} /></span>
              <span className="text-muted-foreground text-sm">{t.mainVersion}{' '}
                <NameLink reference={entry.mainVersion} names={names} unavailable={t.unavailable} unnamed={t.unnamed} /></span>
            </p>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-sm">
              <span>{coverageLabel(entry.completeness, t)}</span>
              {entry.portion ? <span>· {entry.portion}</span> : null}
              {!realization?.ok && entry.language ? <LanguageName tag={entry.language} locale={locale} /> : null}
            </p>
            {realization?.ok
              ? <ul><RealizationRow realization={realization.data} all={loaded} releases={[]} names={names}
                locale={locale} t={t} showLanguage showEvidence={false} anchor={`coverage-${entry.work.slice(-36)}-${realization.data.id.slice(-36)}`} /></ul>
              : realization ? <>
                {entry.revision ? <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">{detail.realizationRevision}: {entry.revision}</p> : null}
                <RegionFailure title={t.realizationUnavailable} failure={realization.failure} messages={workMessages[locale]} />
              </> : null}
          </li>;
        })}
      </ol> : <p className="text-muted-foreground text-sm">{t.noCoverage}</p>}
    </Region>
    <SubjectSources locale={locale}>
      <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">{detail.releaseRevision}: {release.revision}</p>
      <ul className="grid gap-3">{records.map(item => <li key={`${item.id}:${item.revision}`} data-realization-record className="grid min-w-0 gap-1">
        <p><NameLink reference={item.work} names={names} unavailable={t.unavailable} unnamed={t.unnamed} />{' · '}
          <LanguageName tag={item.language} locale={locale} /></p>
        <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">{item.id}</p>
        <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">{detail.realizationRevision}: {item.revision}</p>
        {item.evidence ? <p className="[overflow-wrap:anywhere]">{detail.evidence}:{' '}{sourceHref(item.evidence)
          ? <a href={sourceHref(item.evidence)!} rel="noreferrer noopener" className="rounded-sm text-primary underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring">
            {item.evidence}</a> : <span>{item.evidence}</span>}</p>
          : <p className="text-muted-foreground">{detail.noEvidence}</p>}
      </li>)}</ul>
      {sourceReads.map(item => item.read.ok ? null : <div key={`${item.id}:${item.revision}`} data-unavailable-source className="grid min-w-0 gap-1">
        <p className="[overflow-wrap:anywhere]">{t.continuity}: {item.id}</p>
        <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">{detail.realizationRevision}: {item.revision}</p>
        <RegionFailure title={t.realizationUnavailable} failure={item.read.failure} messages={workMessages[locale]} />
      </div>)}
    </SubjectSources>
  </div>;
}

export function ReleaseFailure({ failure, messages, t }: { failure: Extract<Loaded<Release>, { ok: false }>['failure'];
  messages: WorkPageMessages; t: Copy }) {
  return <Region id="release" title={t.release}>
    <RegionFailure title={t.releaseUnavailable} failure={failure} messages={messages} />
  </Region>;
}
