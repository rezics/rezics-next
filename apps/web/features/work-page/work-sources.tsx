import type { ReactNode } from 'react';
import { LocalizedText } from '@rezics/ui/localized-text';
import type { UiLocale } from '../../i18n/define.ts';
import { CatalogueCoverCredit } from '../catalogue/cover.tsx';
import { coverKindOf } from '../catalogue/work.ts';
import { RightsMark, type DisplayObligations } from '../rights-mark/rights-mark.tsx';
import type { WorkPageMessages } from './messages.ts';
import { PublicationSource, publicationSource } from './publication-source.tsx';
import { WorkRecord } from './record.tsx';
import type { WorkHeader } from './types.ts';
import type { Loaded } from './types.ts';
import type { HrefFor, StatementGroup, StatementPage } from '../entity-page/types.ts';
import type { Names } from '../work-levels/types.ts';
import type { PredicateLabels } from '../entity-page/predicate-labels.ts';
import { externalIdentity, presentStatements, splitStatementSources, withoutOwnName } from '../entity-page/statement-groups.ts';
import { sourceHref, SubjectSources } from '../entity-page/sources.tsx';
import { HoldsIn, Pages, StatementsView, Value } from '../entity-page/views.tsx';
import type { Copy } from '../entity-page/messages.ts';
import { Region } from './region.tsx';

/** External identifiers are source records, rather than prose or domain facts. */
export function workSourceGroups(groups: readonly StatementGroup[]) {
  const { facts, sources } = splitStatementSources(groups);
  return { facts, sources: sources.flatMap(group => withoutOwnName(group)) };
}

export { sourceHref };

/** Keep the shared statement values, applicability and continuation without repeating footer attribution. */
export function WorkFactsView({ page, labels = new Map(), ownName, names, hrefFor, locale, t, messages }: {
  page: Loaded<StatementPage>; labels?: PredicateLabels; ownName?: string; names: Names;
  hrefFor: HrefFor; locale: UiLocale; t: Copy; messages: WorkPageMessages;
}) {
  if (!page.ok) return <StatementsView page={page} names={names} cursor={undefined} hrefFor={hrefFor}
    locale={locale} t={t} messages={messages} />;
  const { facts } = workSourceGroups(page.data.groups);
  const { labelled, other } = presentStatements(facts, labels, ownName);
  if (!labelled.length && !other.length && !page.data.nextCursor) return null;
  const groups = [...labelled.map(group => ({ heading: <LocalizedText text={labels.get(group.predicate)!} />, values: withoutOwnName(group) })),
    ...other.length ? [{ heading: t.otherFacts, values: other }] : []];
  return <Region id="statements" title={t.statements}>
    <div aria-label={t.statementsList} className="grid gap-5">
      {groups.map((group, index) => <div key={index} data-statement-group className="grid min-w-0 gap-1 sm:grid-cols-[minmax(9rem,14rem)_1fr] sm:gap-4">
        <h3 className="break-words font-medium text-muted-foreground text-sm">{group.heading}</h3>
        <ul className="grid min-w-0 gap-1">{group.values.map((item, index) => <li key={`${item.revision}:${index}`} className="min-w-0">
          <Value item={item} names={names} hrefFor={hrefFor} t={t} /><HoldsIn item={item} names={names} t={t} />
        </li>)}</ul>
      </div>)}
    </div>
    <Pages cursor={undefined} next={page.data.nextCursor} section="statements" hrefFor={hrefFor} messages={messages} />
  </Region>;
}

/** Equal obligations share a notice without losing which displayed fields they apply to. */
export function workRights(work: WorkHeader, messages: WorkPageMessages, facts: readonly DisplayObligations[] = []) {
  const groups: { labels: string[]; rights: DisplayObligations }[] = [];
  for (const [label, rights] of [[messages.sourceFacts, work.factObligations],
    ...facts.map(rights => [messages.sourceFacts, rights] as const),
    [messages.sourceDescription, work.descriptionObligations]] as const) {
    if (label === messages.sourceDescription && !work.description) continue;
    if (!rights || rights.status !== 'assessed' || (!rights.instrument && !rights.obligations.length)) continue;
    const existing = groups.find(group => JSON.stringify(group.rights) === JSON.stringify(rights));
    if (existing) { if (!existing.labels.includes(label)) existing.labels.push(label); }
    else groups.push({ labels: [label], rights });
  }
  return groups;
}

/** All views finish with the same sources, licence duties, selected cover credit and evidence. */
export function WorkSources({ work, locale, messages, avatarQuery, statements, labels, factObligations = [], children }: {
  work: WorkHeader; locale: UiLocale; messages: WorkPageMessages; avatarQuery?: string; children?: ReactNode;
  statements?: Loaded<StatementPage>; labels?: PredicateLabels; factObligations?: readonly DisplayObligations[];
}) {
  const rights = workRights(work, messages, [...factObligations, ...statements?.ok ? [statements.data.factObligations] : []]);
  return <SubjectSources locale={locale}><div data-work-sources className="grid min-w-0 gap-5">
    <PublicationSource source={publicationSource(work)} messages={messages} />
    {rights.map(group => <div key={group.labels.join()} className="grid gap-1">
      <h3 className="font-medium text-sm">{group.labels.join(' · ')}</h3>
      <RightsMark rights={group.rights} locale={locale} />
    </div>)}
    <CatalogueCoverCredit work={{ id: work.id, title: work.title, cover: work.cover, kind: coverKindOf(work.types), authors: [] }}
      avatarQuery={avatarQuery} locale={locale} />
    {statements?.ok ? <WorkFieldEvidence page={statements.data} labels={labels} messages={messages} /> : null}
    {children ?? <WorkRecord work={work} locale={locale} messages={messages} />}
  </div></SubjectSources>;
}

const sourceLink = 'rounded-sm text-primary underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-ring';

/** Field evidence describes the supplied records; a provider identity alone never proves field adoption. */
function WorkFieldEvidence({ page, labels = new Map(), messages: t }: {
  page: StatementPage; labels?: PredicateLabels; messages: WorkPageMessages;
}) {
  const { sources } = workSourceGroups(page.groups);
  const rows = page.groups.flatMap(group => withoutOwnName(group));
  if (!rows.length) return null;
  return <div data-work-evidence className="grid min-w-0 gap-4 text-sm">
    {sources.length ? <dl className="grid gap-3">{sources.map((item, index) => {
      const identity = externalIdentity(item)!;
      return <div key={`${item.revision}:${index}`} className="grid gap-1">
        <dt className="text-muted-foreground">{t.sourceRecord}</dt>
        <dd className="[overflow-wrap:anywhere]">{identity.provider} · {identity.namespace} · {identity.key}</dd>
      </div>;
    })}</dl> : null}
    <details className="min-w-0">
      <summary className="w-fit cursor-pointer rounded-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">{t.fieldEvidence}</summary>
      <ul className="mt-3 grid min-w-0 gap-4">{rows.map((item, index) => <li key={`${item.revision}:${index}`} className="grid min-w-0 gap-1">
        <p className="font-medium [overflow-wrap:anywhere]">{labels.has(item.predicate)
          ? <LocalizedText text={labels.get(item.predicate)!} /> : item.predicate}</p>
        <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">{t.recordRevision}: {item.revision}</p>
        {item.sources.length ? <ul className="flex flex-wrap gap-x-4 gap-y-1">{item.sources.map((source, index) => {
          const href = sourceHref(source);
          return <li key={`${source}:${index}`}>{href ? <a href={href} rel="noreferrer noopener" className={sourceLink}>
            {t.evidence} {index + 1}</a> : <span className="[overflow-wrap:anywhere]">{source}</span>}</li>;
        })}</ul> : <p className="text-muted-foreground">{t.fieldEvidenceUnavailable}</p>}
      </li>)}</ul>
    </details>
  </div>;
}
