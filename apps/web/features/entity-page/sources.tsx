import { LocalizedText } from '@rezics/ui/localized-text';
import type { UiLocale } from '../../i18n/define.ts';
import type { ReactNode } from 'react';
import { RightsMark } from '../rights-mark/rights-mark.tsx';
import { Region } from '../work-page/region.tsx';
import type { Loaded } from '../work-page/types.ts';
import type { Names } from '../work-levels/types.ts';
import { copyOf, type Copy } from './messages.ts';
import type { PredicateLabels } from './predicate-labels.ts';
import { externalIdentity, splitStatementSources } from './statement-groups.ts';
import type { HrefFor, StatementItem, StatementPage } from './types.ts';
import { HoldsIn, Value } from './views.tsx';

const linkClass = 'rounded-sm text-primary underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-ring';

/** All hosts share the same page-end landmark; the supplied content keeps its own attribution. */
export function SubjectSources({ locale, children }: { locale: UiLocale; children: ReactNode }) {
  return <Region id="sources" title={copyOf(locale).sources} className="scroll-mt-20 border-border/60 border-t pt-6">
    <div data-subject-sources className="grid min-w-0 gap-4 text-sm">{children}</div>
  </Region>;
}

/** Native identities are references, not advertised evidence routes. Supplied external URLs must also be safe. */
export function sourceHref(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.origin === 'https://rezics.com' && url.pathname.startsWith('/id/')) return null;
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function SourceValue({ item }: { item: StatementItem }) {
  const identity = externalIdentity(item);
  if (identity) return <span className="[overflow-wrap:anywhere]">{identity.provider} · {identity.namespace} · {identity.key}</span>;
  const value = item.value as { lexical?: unknown };
  const href = sourceHref(value.lexical);
  return href ? <a href={href} rel="noreferrer noopener" className={linkClass}>{href}</a>
    : typeof value.lexical === 'string' ? <span className="[overflow-wrap:anywhere]">{value.lexical}</span> : null;
}

type Evidence = NonNullable<Extract<StatementItem, { kind: 'statement' }>['evidence']>[number];

/** Retained locators/methods are structured public data, not executable links or a fresh rights assessment. */
function RecordedValue({ value, t, quoteWithheld = false }: { value: unknown; t: Copy; quoteWithheld?: boolean }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">{t.notSupplied}</span>;
  if (Array.isArray(value)) return <ol className="grid gap-1 ps-4 [list-style:decimal]">
    {value.map((child, index) => <li key={index}><RecordedValue value={child} t={t} quoteWithheld={quoteWithheld} /></li>)}
  </ol>;
  if (typeof value === 'object') return <dl className="grid gap-1 border-s border-border/60 ps-3">
    {Object.entries(value).map(([key, child]) => <div key={key} className="grid min-w-0 gap-0.5">
      <dt className="text-muted-foreground">{key}</dt>
      <dd className="min-w-0 [overflow-wrap:anywhere]"><RecordedValue
        value={quoteWithheld && ['quote', 'exact', 'prefix', 'suffix'].includes(key) ? null : child}
        t={t} quoteWithheld={quoteWithheld} /></dd>
    </div>)}
  </dl>;
  return <span dir="auto" className="[overflow-wrap:anywhere]">{String(value)}</span>;
}

function EvidenceDetails({ evidence, t }: { evidence: Evidence; t: Copy }) {
  const fields = [
    [t.evidenceReference, evidence.id],
    [t.sourceWork, evidence.sourceWork],
    [t.sourceRepresentation, evidence.representationSha256],
    [t.sourceLocation, evidence.locator],
    [t.evidenceMethod, evidence.method],
    [t.evidenceModality, evidence.modality],
    [t.evidenceSubmitter, evidence.submitter],
    [t.evidenceRights, evidence.rightsBasis],
  ] as const;
  return <div data-claim-evidence className="grid min-w-0 gap-3 border-border/60 border-s ps-3 text-xs">
    <dl className="grid min-w-0 gap-3">{fields.map(([label, value]) => <div key={label} className="grid min-w-0 gap-1">
      <dt className="font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0"><RecordedValue value={value} t={t} quoteWithheld={evidence.quoteWithheld} /></dd>
    </div>)}</dl>
    {evidence.quoteWithheld ? <p className="text-muted-foreground">{t.quotationWithheld}</p>
      : evidence.quote !== null ? <figure><figcaption className="text-muted-foreground">{t.quotation}</figcaption>
        <blockquote dir="auto" className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{evidence.quote}</blockquote></figure> : null}
  </div>;
}

/** One page-end owner keeps source identity, exact evidence and assessed rights together. */
export function StatementSourcesView({ page, labels = new Map(), names = new Map(), hrefFor, locale, t }: {
  page: Loaded<StatementPage>; labels?: PredicateLabels; names?: Names; hrefFor: HrefFor; locale: UiLocale; t: Copy;
}) {
  if (!page.ok) return null; // The facts region owns the failed read and its retry.
  const { sources } = splitStatementSources(page.data.groups);
  // The header's own name is still a displayed fact, even though the body does not repeat it.
  const rows = page.data.groups.flatMap(group => group.items);
  const evidenced = rows.filter(item => item.sources.length > 0 || (item.kind === 'statement' && item.evidence?.length));
  const sourceItems = new Set(sources.flatMap(group => group.items));
  const claims = rows.filter(item => !sourceItems.has(item) || evidenced.includes(item));
  const rights = page.data.factObligations;
  const hasRights = rights.status === 'assessed' && (rights.instrument || rights.obligations.length);
  if (!rows.length && !hasRights) return null;
  return <SubjectSources locale={locale}>
      {sources.length ? <dl className="grid gap-3">
        {sources.flatMap(group => group.items.map((item, index) => <div key={`${item.revision}:${index}`} className="grid min-w-0 gap-1">
          <dt className="text-muted-foreground">{externalIdentity(item) ? t.sourceIdentity : t.sourceRecord}</dt>
          <dd className="min-w-0"><SourceValue item={item} /></dd>
        </div>))}
      </dl> : null}
      {claims.length ? <ul className="grid min-w-0 gap-4">
        {claims.map((item, index) => {
          const evidence = item.kind === 'statement' ? item.evidence ?? [] : [];
          const references = item.sources.filter(source => !evidence.some(entry => entry.id === source));
          return <li key={`${item.revision}:${index}`} data-fact-citation className="grid min-w-0 gap-2">
          <p className="font-medium">{labels.has(item.predicate) ? <LocalizedText text={labels.get(item.predicate)!} />
            : <span className="[overflow-wrap:anywhere]">{t.otherFacts} · {item.predicate}</span>}</p>
          <p data-cited-value className="min-w-0">{externalIdentity(item) ? <SourceValue item={item} />
            : <Value item={item} names={names} hrefFor={hrefFor} t={t} />}
            <HoldsIn item={item} names={names} t={t} /></p>
          <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">{t.factRevision}: {item.revision}</p>
          {references.length ? <ul className="flex flex-wrap gap-x-4 gap-y-1">{references.map((source, sourceIndex) => {
            const href = sourceHref(source);
            return <li key={source}>{href ? <a href={href} rel="noreferrer noopener" className={linkClass}>
              {t.evidence} {sourceIndex + 1}</a> : <span className="text-muted-foreground [overflow-wrap:anywhere]">{source}</span>}</li>;
          })}</ul> : null}
          {evidence.map(entry => <EvidenceDetails key={entry.id} evidence={entry} t={t} />)}
          {!references.length && !evidence.length ? <p className="text-muted-foreground text-xs">{t.noEvidence}</p> : null}
        </li>;})}
      </ul> : null}
      {!evidenced.length ? <p className="text-muted-foreground">{t.fieldEvidenceUnavailable}</p> : null}
      <RightsMark rights={rights} locale={locale} />
  </SubjectSources>;
}
