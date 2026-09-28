'use client';

import { Badge } from '@rezics/ui/badge';
import { KeyRoundIcon, ShieldCheckIcon } from 'lucide-react';
import { useAdminClient } from '../api/admin-client.tsx';
import type { ActivityPage, UserDetail } from '../api/types.ts';
import { actionLabel } from '../audit/entry.tsx';
import { DateOnly, Time } from '../format.tsx';
import { Empty, Facts, Panel, usePages } from './parts.tsx';
import { Devices } from './overview-tab.tsx';
import { useTranslation } from '../../../i18n/client.ts';

type Event = ActivityPage['items'][number];
type AdminText = ReturnType<typeof useTranslation<'admin'>>['t'];

/** A security event's own words, plus its detail where it has one. */
function eventDetail(event: Event, t: AdminText): string | null {
  const detail = event.detail as { device?: { label?: string }; network?: string | null; action?: string; clientId?: string; method?: string };
  if (event.action === 'admin_action' && detail.action) return actionLabel(detail.action, t);
  if (detail.device?.label) return [detail.device.label, detail.network].filter(Boolean).join(' · ');
  return detail.clientId ?? detail.method ?? null;
}

export function SecurityTab({ detail }: { detail: UserDetail }) {
  const { t } = useTranslation('admin');
  const { api } = useAdminClient();
  const userId = detail.profile.id;
  const sessions = usePages(detail.sessions, cursor => api.sessions(userId, cursor));
  const activity = usePages(detail.activity, cursor => api.activity(userId, cursor));
  const { methods } = detail;
  const failed = detail.activity.failedAttemptsLast24Hours;
  return <div className="grid gap-4 lg:grid-cols-2">
    <Panel title={t.user.methods}><Facts rows={[
      [t.user.password, methods.password ? t.user.passwordSet : t.user.passwordNone],
      [t.user.passkeys, methods.passkeys.length ? <ul key="passkeys" className="flex flex-col gap-1">
        {methods.passkeys.map(passkey => <li key={passkey.id} className="flex flex-wrap items-center gap-2">
          <KeyRoundIcon className="size-4 text-muted-foreground" aria-hidden="true" />{passkey.name ?? passkey.deviceType}
          {passkey.backedUp ? <Badge variant="outline" size="sm">{t.user.backedUp}</Badge> : null}
          <span className="text-xs text-muted-foreground"><DateOnly iso={passkey.createdAt} /></span></li>)}
      </ul> : t.user.noPasskeys],
      [t.user.authenticator, methods.totp?.verified ? <span key="totp" className="inline-flex items-center gap-1.5">
        <ShieldCheckIcon className="size-4 text-success-foreground" aria-hidden="true" />{methods.totp.name}</span> : t.user.authenticatorOff],
    ]} /></Panel>
    <Devices sessions={sessions.items} more={sessions.button} />
    <Panel title={t.user.activity} description={t.user.failedLastDay(failed.count)} className="lg:col-span-2">
      {activity.items.length ? <ol className="divide-y divide-border/60 border-t border-border/60">
        {activity.items.map(event => {
          const extra = eventDetail(event, t);
          return <li key={event.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-5 py-2.5 text-sm group-data-[density=compact]/admin:py-1.5">
            <span className={event.action === 'sign_in_failed' ? 'font-medium text-destructive-foreground' : 'font-medium'}>
              {(t.activityLabels as Record<string, string>)[event.action] ?? event.action}</span>
            {extra ? <span className="text-muted-foreground">{extra}</span> : null}
            <Time iso={event.occurredAt} className="ms-auto text-xs text-muted-foreground" />
          </li>;
        })}
      </ol> : <Empty>{t.user.noActivity}</Empty>}
      {activity.button}
    </Panel>
  </div>;
}
