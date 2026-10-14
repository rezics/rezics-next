'use client';

import { Alert, AlertTitle } from '@rezics/ui/alert';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import type { MainClient } from '../discover/types.ts';
import { stateLabel } from '../manage/labels.ts';
import { messages as manageMessages } from '../manage/messages.ts';
import { RealmFrame } from '../manage/realm-frame.tsx';
import { QueueView } from '../manage/queue-view.tsx';
import { noNames } from '../manage/queue-api.ts';
import type { ModerationItem } from '../manage/types.ts';
import { RealmBanPanel } from './panel.tsx';
import { messages as appealMessages } from './messages.ts';
import type { BanReading } from './reading.ts';
import { recordedModerationQueueApi, type RealmModerationMapped } from './realm-moderation-recorded-page.ts';

function recordedNow(openedAt: string | undefined): number {
  const parsed = openedAt ? Date.parse(openedAt) : Number.NaN;
  return Number.isNaN(parsed) ? Date.parse('2026-10-13T00:00:00.000Z') : parsed;
}

function CaseNote({ item, generation, appeal, locale }: {
  item: ModerationItem; generation: string; appeal: BanReading | null; locale: UiLocale;
}) {
  const t = materializeData(manageMessages, { locale });
  const statement = appeal && appeal.appeal.state !== 'none' ? appeal.appeal.statement : null;
  return <section aria-label={item.id} className="grid min-w-0 gap-3">
    <h2 className="text-balance font-semibold text-lg">{t.decisionEntry({ outcome: stateLabel(item, t), generation })}</h2>
    <p className="break-all font-mono text-sm">{item.id}</p>
    {appeal ? <div className="grid gap-2 text-sm">
      <h3 className="font-medium">{t.reasonLabel}</h3>
      <blockquote className="whitespace-pre-wrap [overflow-wrap:anywhere]">{appeal.reason}</blockquote>
      {statement ? <>
        <h3 className="font-medium">{t.submittedText}</h3>
        <blockquote className="whitespace-pre-wrap [overflow-wrap:anywhere]">{statement}</blockquote>
      </> : null}
    </div> : null}
  </section>;
}

/** The queue or the ban panel. Stories and the mapping render this; a discrepancy is the record's own words. */
export function RealmModerationRecordedPage({ mapped, client, locale }: {
  mapped: RealmModerationMapped; client: MainClient; locale: UiLocale;
}) {
  if (mapped.kind === 'discrepancy') return <p role="alert">{mapped.detail}</p>;
  if (mapped.kind === 'refusal') {
    return <div className="p-4">
      <Alert role="alert" variant="destructive" className="max-w-3xl">
        <AlertTitle><h1 className="text-balance font-semibold text-lg">{mapped.problem.title}</h1></AlertTitle>
      </Alert>
    </div>;
  }
  if (mapped.kind === 'appeal') {
    return <RealmBanPanel reading={mapped.reading} realm={mapped.realm} locale={locale} messages={appealMessages} />;
  }
  const opened = mapped.page.items[0]?.openedAt;
  return <div className="min-w-0">
    {/* No recorded settings or zone read, so the frame does not ask for either. */}
    <RealmFrame realm={mapped.realm} header={mapped.header} agent={mapped.agent} locale={locale} messages={manageMessages}
      settingsAllowed={false} siteHref={null}>
      <div className="grid min-w-0 gap-8">
        <QueueView principal={mapped.actingSubject} realm={mapped.realm} actingSubject={mapped.actingSubject}
          view={mapped.view} initial={mapped.page} names={noNames} now={recordedNow(opened)} locale={locale}
          messages={manageMessages} appealClient={client} appealAuthority={{ dismiss: true, restore: false }}
          api={recordedModerationQueueApi(client, mapped.realm, mapped.actingSubject, locale)} />
        {mapped.page.items.map(item => {
          const basis = mapped.basis?.caseId === item.id ? mapped.basis : null;
          const appeal = mapped.appeal && (mapped.appeal.receiptId === item.target.resource
            || (mapped.appeal.appeal.state !== 'none' && mapped.appeal.appeal.caseId === item.id)) ? mapped.appeal : null;
          return <CaseNote key={item.id} item={item} generation={basis?.generation ?? item.generation} appeal={appeal}
            locale={locale} />;
        })}
      </div>
    </RealmFrame>
  </div>;
}
