'use client';

import { Alert, AlertAction, AlertDescription, AlertTitle } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { ShieldAlertIcon } from 'lucide-react';
import { ActivityList, type ActivityView, SECURE_ACCOUNT_PATH } from './activity-list.tsx';
import { SectionHeading, SettingsCard } from './account-shell.tsx';
import { FAILED_SIGN_IN_ALERT } from './activity.ts';
import { ReadStatePanel } from '../shell/state-panel.tsx';
import { useTranslation } from '../../i18n/client.ts';

export type ActivityPageView = { status: 'ok'; entries: ActivityView[]; failed: { count: number; capped: boolean };
  apps?: Record<string, string>;
  /** The next page's cursor while older events inside the 90-day window may exist. */
  older: string | null; paged: boolean } | { status: 'unavailable' | 'signed-out' | 'stale' | 'missing' };

/** Security activity from the last 90 days, newest first. */
export function SecurityActivityPage({ activity }: { activity: ActivityPageView }) {
  const { t } = useTranslation('account');
  const heading = <SectionHeading back={{ href: '/security', label: t.security }} title={t.activity}
    intro={t.activityPageIntro} />;
  if (activity.status !== 'ok') return <>{heading}<ReadStatePanel status={activity.status} next="/security/activity" /></>;
  const { failed } = activity;
  return <>
    {heading}
    <div className="flex flex-col gap-6">
      {failed.count >= FAILED_SIGN_IN_ALERT ? <Alert variant="warning">
        <ShieldAlertIcon aria-hidden="true" />
        <AlertTitle>{t.checkupFailedSignIns(failed.count)}</AlertTitle>
        <AlertDescription>{t.failedSignInsBody}</AlertDescription>
        <AlertAction><Button variant="outline" size="sm" asChild><a href={SECURE_ACCOUNT_PATH}>{t.secureAccount}</a></Button></AlertAction>
      </Alert> : null}
      <SettingsCard title={activity.paged ? t.olderActivity : t.recentActivity}>
        <ActivityList entries={activity.entries} apps={activity.apps} />
        <div className="flex flex-wrap gap-3 border-t border-border/60 px-5 py-3 sm:px-6">
          {activity.paged ? <Button variant="link" className="px-0" asChild><a href="/security/activity">{t.newestActivity}</a></Button> : null}
          {activity.older ? <Button variant="link" className="px-0" asChild>
            <a href={`/security/activity?cursor=${encodeURIComponent(activity.older)}`}>{t.showOlder}</a></Button>
            : <p className="py-2 text-sm text-muted-foreground">{t.activityWindow}</p>}
        </div>
      </SettingsCard>
    </div>
  </>;
}
