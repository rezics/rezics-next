import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { CatalogueCoverCredit } from '../catalogue/cover.tsx';
import { coverKindOf } from '../catalogue/work.ts';
import { RightsMark, type DisplayObligations } from '../rights-mark/rights-mark.tsx';
import type { WorkPageMessages } from './messages.ts';
import { PublicationSource, publicationSource } from './publication-source.tsx';
import { WorkRecord } from './record.tsx';
import type { WorkHeader } from './types.ts';

/** Equal obligations share a notice without losing which displayed fields they apply to. */
export function workRights(work: WorkHeader, messages: WorkPageMessages) {
  const groups: { labels: string[]; rights: DisplayObligations }[] = [];
  for (const [label, rights] of [[messages.sourceFacts, work.factObligations],
    [messages.sourceDescription, work.descriptionObligations]] as const) {
    if (label === messages.sourceDescription && !work.description) continue;
    if (!rights || rights.status !== 'assessed' || (!rights.instrument && !rights.obligations.length)) continue;
    const existing = groups.find(group => JSON.stringify(group.rights) === JSON.stringify(rights));
    if (existing) existing.labels.push(label);
    else groups.push({ labels: [label], rights });
  }
  return groups;
}

/** All views finish with the same sources, licence duties, selected cover credit and evidence. */
export function WorkSources({ work, locale, messages, avatarQuery, children }: {
  work: WorkHeader; locale: UiLocale; messages: WorkPageMessages; avatarQuery?: string; children?: ReactNode;
}) {
  const rights = workRights(work, messages);
  return <section aria-labelledby="work-sources" data-work-sources className="grid min-w-0 gap-5 border-t border-border/70 pt-6">
    <h2 id="work-sources" className="font-semibold text-lg">{messages.sourcesAndEvidence}</h2>
    <PublicationSource source={publicationSource(work)} messages={messages} />
    {rights.map(group => <div key={group.labels.join()} className="grid gap-1">
      <h3 className="font-medium text-sm">{group.labels.join(' · ')}</h3>
      <RightsMark rights={group.rights} locale={locale} />
    </div>)}
    <CatalogueCoverCredit work={{ id: work.id, title: work.title, cover: work.cover, kind: coverKindOf(work.types), authors: [] }}
      avatarQuery={avatarQuery} locale={locale} />
    {children ?? <WorkRecord work={work} locale={locale} messages={messages} />}
  </section>;
}
