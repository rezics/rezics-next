import { LocalizedText } from '@rezics/ui/localized-text';
import type { UiLocale } from '../../i18n/define.ts';
import type { ReactNode } from 'react';
import { RightsMark } from '../rights-mark/rights-mark.tsx';
import { Region } from '../work-page/region.tsx';
import type { Loaded } from '../work-page/types.ts';
import { copyOf, type Copy } from './messages.ts';
import type { PredicateLabels } from './predicate-labels.ts';
import { externalIdentity, splitStatementSources } from './statement-groups.ts';
import type { StatementItem, StatementPage } from './types.ts';

const linkClass = 'rounded-sm text-primary underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-ring';

/** All hosts share the same page-end landmark; the supplied content keeps its own attribution. */
export function SubjectSources({ locale, children }: { locale: UiLocale; children: ReactNode }) {
  return <Region id="sources" title={copyOf(locale).sources} className="scroll-mt-20 border-border/60 border-t pt-6">
    <div data-subject-sources className="grid min-w-0 gap-4 text-sm">{children}</div>
  </Region>;
}

/** Never turn an arbitrary stored value into an executable URL. */
export function sourceHref(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
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

/** One page-end owner keeps source identity, exact evidence and assessed rights together. */
export function StatementSourcesView({ page, labels = new Map(), locale, t }: {
  page: Loaded<StatementPage>; labels?: PredicateLabels; locale: UiLocale; t: Copy;
}) {
  if (!page.ok) return null; // The facts region owns the failed read and its retry.
  const { sources } = splitStatementSources(page.data.groups);
  // The header's own name is still a displayed fact, even though the body does not repeat it.
  const rows = page.data.groups.flatMap(group => group.items);
  const evidenced = rows.filter(item => item.sources.length > 0);
  const rights = page.data.factObligations;
  const hasRights = rights.status === 'assessed' && (rights.instrument || rights.obligations.length);
  if (!sources.length && !evidenced.length && !hasRights) return null;
  return <SubjectSources locale={locale}>
      {sources.length ? <dl className="grid gap-3">
        {sources.flatMap(group => group.items.map((item, index) => <div key={`${item.revision}:${index}`} className="grid min-w-0 gap-1">
          <dt className="text-muted-foreground">{externalIdentity(item) ? t.sourceIdentity : t.sourceRecord}</dt>
          <dd className="min-w-0"><SourceValue item={item} /></dd>
        </div>))}
      </dl> : null}
      {evidenced.length ? <ul className="grid min-w-0 gap-3">
        {evidenced.map((item, index) => <li key={`${item.revision}:${index}`} className="grid gap-1">
          <p className="font-medium">{labels.has(item.predicate) ? <LocalizedText text={labels.get(item.predicate)!} /> : t.otherFacts}</p>
          <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">{t.recordRevision}: {item.revision}</p>
          <ul className="flex flex-wrap gap-x-4 gap-y-1">{item.sources.map((source, sourceIndex) => {
            const href = sourceHref(source);
            return <li key={source}>{href ? <a href={href} rel="noreferrer noopener" className={linkClass}>
              {t.evidence} {sourceIndex + 1}</a> : <span className="text-muted-foreground [overflow-wrap:anywhere]">{source}</span>}</li>;
          })}</ul>
        </li>)}
      </ul> : sources.length ? <p className="text-muted-foreground">{t.fieldEvidenceUnavailable}</p> : null}
      <RightsMark rights={rights} locale={locale} />
  </SubjectSources>;
}
