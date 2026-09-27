'use client';

import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import { ScrollTextIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useMemo, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { browserMainApi } from '../api/browser.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { agentLabel, dateTime, relativeTime, shownHandle } from './format.ts';
import { auditKindLabel, auditOutcome, publicDecisionLabel } from './labels.ts';
import type { ManageMessages } from './messages.ts';
import { AgentMark, Named, Pill } from './parts.tsx';
import { readAgents, readAudit, readPublicDecisions, readWorks } from './read.ts';
import { type AuditFilter, type LogView as View, logHref } from './routes.ts';
import { type AgentSummary, type AuditItem, type AuditPage, type Loaded, type PublicDecision, type PublicDecisionPage,
  uuidOf, type WorkSummary } from './types.ts';

/** Later pages of either log. Stories pass a stand-in. */
export interface LogApi {
  audit(kind: AuditFilter | null, cursor: string): Promise<Loaded<AuditPage>>;
  decisions(cursor: string): Promise<Loaded<PublicDecisionPage>>;
  names(agents: readonly string[], works: readonly string[]): Promise<{ agents: Record<string, AgentSummary>;
    works: Record<string, WorkSummary> }>;
}

export function bffLogApi(realm: string, actingSubject: string, language: string): LogApi {
  return {
    audit: (kind, cursor) => readAudit(browserMainApi(), realm, { actingSubject, kind, cursor }),
    decisions: cursor => readPublicDecisions(browserMainApi(), realm, cursor),
    async names(agents, works) {
      const main = browserMainApi();
      const [a, w] = await Promise.all([readAgents(main, agents), readWorks(main, works, { language, actingSubject })]);
      return { agents: a, works: w };
    },
  };
}

const auditFilters: ReadonlyArray<[AuditFilter | null, 'auditAll' | 'auditModeration' | 'auditRights'
  | 'auditPublication' | 'auditManagement']> = [[null, 'auditAll'], ['realm_management', 'auditManagement'],
  ['content_moderation', 'auditModeration'], ['rights_disposition', 'auditRights'],
  ['organization_publication_rejection', 'auditPublication']];

/**
 * The Realm's record: the private audit log of who changed what and why, and
 * the public decisions everyone can see. Filters live in the address.
 */
export function LogView({ realm, actingSubject, view, first, agents: initialAgents, works: initialWorks, now,
  locale, messages, api: givenApi }: {
  realm: string; actingSubject: string; view: View;
  first: { kind: 'audit'; page: AuditPage } | { kind: 'public'; page: PublicDecisionPage };
  agents: Record<string, AgentSummary>; works: Record<string, WorkSummary>; now: number;
  locale: UiLocale; messages: ManageMessages; api?: LogApi;
}) {
  const t = useMemo(() => materializeData(messages, { locale }), [messages, locale]);
  const api = useMemo(() => givenApi ?? bffLogApi(realm, actingSubject, locale), [givenApi, realm, actingSubject, locale]);
  const [audit, setAudit] = useState<AuditItem[]>(first.kind === 'audit' ? first.page.items : []);
  const [decisions, setDecisions] = useState<PublicDecision[]>(first.kind === 'public' ? first.page.items : []);
  const [cursor, setCursor] = useState(first.page.nextCursor);
  const [paging, setPaging] = useState<'idle' | 'loading' | 'moved' | 'failed'>('idle');
  const [names, setNames] = useState({ agents: initialAgents, works: initialWorks });

  async function more() {
    if (!cursor) return;
    setPaging('loading');
    if (first.kind === 'audit') {
      const read = await api.audit(view.kind, cursor);
      if (!read.ok) { setPaging(read.failure === 'moved' ? 'moved' : 'failed'); return; }
      setAudit(items => [...items, ...read.data.items]);
      setCursor(read.data.nextCursor);
      const found = await api.names(read.data.items.map(item => item.actingSubject), []);
      setNames(known => ({ ...known, agents: { ...known.agents, ...found.agents } }));
    } else {
      const read = await api.decisions(cursor);
      if (!read.ok) { setPaging(read.failure === 'moved' ? 'moved' : 'failed'); return; }
      setDecisions(items => [...items, ...read.data.items]);
      setCursor(read.data.nextCursor);
      const found = await api.names([], read.data.items.flatMap(item => item.work ? [item.work] : []));
      setNames(known => ({ ...known, works: { ...known.works, ...found.works } }));
    }
    setPaging('idle');
  }

  const agentName = (iri: string) => agentLabel(names.agents[iri], iri, id => t.agentFallback({ id }));
  const empty = first.kind === 'audit' ? !audit.length : !decisions.length;
  return <div className="grid gap-5">
    <div className="space-y-1">
      <h2 className="font-semibold text-xl tracking-tight">{t.logTitle}</h2>
      <p className="max-w-2xl text-muted-foreground text-sm">{view.view === 'audit' ? t.privateLogHelp : t.publicLogHelp}</p>
    </div>
    <div className="grid gap-3">
      <nav aria-label={t.logViews} className="flex gap-2">
        <Pill href={logHref(realm, { view: 'audit', kind: null })} current={view.view === 'audit'}>{t.privateLog}</Pill>
        <Pill href={logHref(realm, { view: 'public', kind: null })} current={view.view === 'public'}>{t.publicLog}</Pill>
      </nav>
      {view.view === 'audit' ? <nav aria-label={t.auditKindLabel} className="flex gap-2 overflow-x-auto pb-1">
        {auditFilters.map(([kind, label]) => <Pill key={label} href={logHref(realm, { view: 'audit', kind })}
          current={view.kind === kind}>{t[label]}</Pill>)}
      </nav> : null}
    </div>
    {empty ? <EmptyState icon={ScrollTextIcon} title={view.view === 'audit' ? t.emptyAuditTitle : t.emptyPublicTitle}
      description={view.view === 'audit' ? t.emptyAuditHelp : t.emptyPublicHelp} />
      : <ol className="grid divide-y divide-border/60 rounded-2xl border border-border/60 bg-card">
        {first.kind === 'audit' ? audit.map(item => {
          const name = agentName(item.actingSubject);
          const handle = shownHandle(names.agents[item.actingSubject]?.handle ?? null);
          return <li key={item.id} className="flex gap-3 px-4 py-3.5">
            <AgentMark name={name} iri={item.actingSubject} />
            <div className="grid min-w-0 flex-1 gap-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <p className="font-medium">{auditOutcome(item, t)}</p>
                <time dateTime={item.decidedAt} title={dateTime(item.decidedAt, locale)}
                  className="text-muted-foreground text-xs">{relativeTime(item.decidedAt, now, locale)}</time>
              </div>
              <p className="text-muted-foreground text-sm">{t.byAgent({ agent: name })}{handle ? ` ${handle}` : ''}</p>
              {item.reason ? <p className="text-sm" dir="auto">“{item.reason}”</p> : null}
              <div><Badge variant="secondary">{auditKindLabel(item.kind, t)}</Badge></div>
            </div>
          </li>;
        }) : decisions.map(item => {
          const work = item.work ? names.works[item.work] : undefined;
          return <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
            <div className="grid min-w-0 gap-0.5">
              <p className="font-medium">{publicDecisionLabel(item, t)}</p>
              {item.work ? <LocalizedLink href={`/w/${uuidOf(item.work)}`} className="truncate text-primary text-sm hover:underline">
                {work ? <Named name={work.title} /> : t.workFallback}</LocalizedLink> : null}
            </div>
            {item.outcome ? <Badge variant={item.outcome === 'accepted' ? 'soft' : 'secondary'}>
              {item.outcome === 'accepted' ? t.outcomeAccepted : t.outcomeRejected}</Badge> : null}
          </li>;
        })}
      </ol>}
    {cursor ? <div>
      {paging === 'moved' ? <p className="text-sm">{t.movedTitle}{' '}
        <LocalizedLink href={logHref(realm, view)} className="font-medium text-primary hover:underline">{t.startOver}</LocalizedLink></p>
        : <Button variant="outline" size="sm" isLoading={paging === 'loading'} onClick={() => void more()}>
          {paging === 'loading' ? t.loadingMore : paging === 'failed' ? t.retry : t.loadMore}</Button>}
    </div> : null}
  </div>;
}
