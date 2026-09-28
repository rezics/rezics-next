'use client';

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@rezics/ui/accordion';
import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { AppWindowIcon, CircleAlertIcon, CircleCheckIcon, FingerprintIcon, HistoryIcon, InfoIcon, LaptopIcon,
  LockKeyholeIcon, type LucideIcon, MailIcon, ShieldAlertIcon, ShieldCheckIcon, ShieldIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { type CheckupArea, checkupAreas, type CheckupIssue, type CheckupTone, areaTone, issueArea,
  urgentIssues } from './activity.ts';
import { ActivityList, type ActivityView } from './activity-list.tsx';
import { SectionHeading } from './account-shell.tsx';
import { issueActions, useIssueCopy } from './checkup-card.tsx';
import type { DevicesView } from './devices.tsx';
import { useDeviceName } from './devices.tsx';
import { focusedPaths, sectionPaths } from './sections.ts';
import { useTranslation } from '../../i18n/client.ts';

/** Everything the checkup reviews, read and localized on the server; a
 * source that could not be read is `unavailable` and says so in its area. */
export interface CheckupView {
  /** All four sources answered; an unknown source cannot prove the account is protected. */
  complete: boolean;
  issues: CheckupIssue[];
  failedSignIns: number;
  devices: DevicesView;
  activity: { status: 'ok'; entries: ActivityView[]; apps?: Record<string, string> } | { status: 'unavailable' };
  signIn: { email: string; emailVerified: boolean; password: boolean; passwordChanged: string | null;
    passkeys: number; twoStep: boolean } | null;
  apps: { status: 'ok'; items: { clientId: string; name: string; lastUsed: string | null; unused: boolean }[] }
    | { status: 'unavailable' };
}

const areaIcons: Record<CheckupArea, LucideIcon> = { devices: LaptopIcon, activity: HistoryIcon,
  'sign-in': ShieldIcon, apps: AppWindowIcon };
const toneIcons: Record<CheckupTone, LucideIcon> = { ok: CircleCheckIcon, tip: InfoIcon,
  warn: CircleAlertIcon, unknown: InfoIcon };
const toneColours: Record<CheckupTone, string> = { ok: 'text-success-foreground', tip: 'text-info-foreground',
  warn: 'text-warning-foreground', unknown: 'text-muted-foreground' };
/** How many devices and activity entries an area lists before its "manage" link. */
const LISTED = 4;

function Row({ icon: Icon, label, children, href, action }: { icon: LucideIcon; label: string; children: ReactNode;
  href?: string; action?: string }) {
  return <li className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    <span className="w-36 shrink-0 text-muted-foreground max-sm:w-auto">{label}</span>
    <span className="min-w-0 flex-1 font-medium max-sm:basis-full max-sm:ps-8">{children}</span>
    {href && action ? <Button variant="link" size="sm" className="h-auto px-0 max-sm:ps-8" asChild><a href={href}>{action}</a></Button> : null}
  </li>;
}

/** Google Account's Security Checkup for REZICS: one status, then each area
 * the account depends on (devices, activity, sign-in and recovery, Apps) with
 * what was found and how to fix it. Areas with something to do start open. */
export function SecurityCheckup({ checkup }: { checkup: CheckupView }) {
  const { t } = useTranslation('account');
  const common = useTranslation('common').t;
  const copy = useIssueCopy();
  const deviceName = useDeviceName();
  const { issues, devices, activity, signIn, apps } = checkup;
  const unused = apps.status === 'ok' ? apps.items.filter(app => app.unused).length : 0;
  const counts = { failedSignIns: checkup.failedSignIns, unusedApps: unused };
  const overall: CheckupTone = issues.some(issue => urgentIssues.has(issue)) ? 'warn' : issues.length ? 'tip'
    : checkup.complete ? 'ok' : 'unknown';
  const Status = overall === 'ok' ? ShieldCheckIcon : overall === 'warn' ? ShieldAlertIcon : ShieldIcon;
  const unavailable = <p className="py-2 text-muted-foreground">{common.unavailableBody}</p>;
  const readable = (area: CheckupArea) => area === 'devices' ? devices.status === 'ok'
    : area === 'activity' ? activity.status === 'ok' : area === 'sign-in' ? !!signIn : apps.status === 'ok';

  const fixes = (area: CheckupArea) => {
    const found = issues.filter(issue => issueArea[issue] === area);
    if (!found.length) return null;
    return <ul className="mb-2 flex flex-col gap-2">{found.map(issue => {
      const [title, body, action] = copy(issue, counts);
      return <li key={issue} className={cn('flex flex-col gap-3 rounded-2xl p-4 sm:flex-row sm:items-center',
        urgentIssues.has(issue) ? 'bg-warning/8' : 'bg-info/6')}>
        <div className="min-w-0 flex-1"><p className="font-medium">{title}</p>
          <p className="text-muted-foreground">{body}</p></div>
        <Button variant="outline" asChild className="shrink-0"><a href={issueActions[issue]}>{action}</a></Button>
      </li>;
    })}</ul>;
  };

  const areas: Record<CheckupArea, { title: string; summary: string; body: ReactNode }> = {
    devices: { title: t.devices,
      summary: devices.status === 'ok' ? t.deviceCount(devices.items.length) : common.unavailableTitle,
      body: devices.status !== 'ok' ? unavailable : <>
        <ul className="divide-y divide-border/60">
          {devices.items.slice(0, LISTED).map(item => <li key={item.id} className="flex flex-wrap items-baseline gap-x-3 py-2.5">
            <span className="font-medium">{item.clientName && !item.browser ? item.clientName : deviceName(item)}</span>
            <span className="text-muted-foreground">{item.thisDevice ? t.thisDevice : t.lastActive({ time: item.lastActive })}</span>
          </li>)}
        </ul>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="outline" asChild><a href={focusedPaths.devices}>{t.manageAllDevices}</a></Button>
          <Button variant="ghost" asChild><a href={focusedPaths.secureAccount}>{t.unrecognizedDevice}</a></Button>
        </div>
      </> },
    activity: { title: t.activity,
      summary: activity.status !== 'ok' ? common.unavailableTitle
        : checkup.failedSignIns ? t.checkupFailedSignIns(checkup.failedSignIns) : t.checkupNoFailedSignIns,
      body: activity.status !== 'ok' ? unavailable : <>
        {fixes('activity')}
        <div className="-mx-5 sm:-mx-6"><ActivityList entries={activity.entries.slice(0, LISTED)} apps={activity.apps} /></div>
        <div className="mt-3"><Button variant="outline" asChild><a href={focusedPaths.activity}>{t.reviewActivity}</a></Button></div>
      </> },
    'sign-in': { title: t.checkupSignIn,
      summary: !signIn ? common.unavailableTitle : issues.some(issue => issueArea[issue] === 'sign-in')
        ? t.checkupSignInWeak : t.checkupSignInStrong,
      body: !signIn ? unavailable : <>
        {fixes('sign-in')}
        <ul className="divide-y divide-border/60">
          <Row icon={MailIcon} label={t.checkupRecoveryEmail} href={sectionPaths['personal-info']} action={t.reviewEmail}>
            <span className="break-all">{signIn.email}</span>{' '}
            <Badge variant={signIn.emailVerified ? 'success' : 'warning'} size="sm">{signIn.emailVerified ? t.verified : t.unverified}</Badge>
          </Row>
          <Row icon={LockKeyholeIcon} label={t.password} href={`${sectionPaths.security}#password`} action={t.changePassword}>
            {signIn.password ? signIn.passwordChanged ? t.passwordLastChanged({ date: signIn.passwordChanged }) : t.methodOn
              : t.passwordNotSet}
          </Row>
          <Row icon={FingerprintIcon} label={t.methodPasskeys} href={focusedPaths.passkeys} action={t.reviewPasskeys}>
            {t.passkeyCount(signIn.passkeys)}</Row>
          <Row icon={ShieldCheckIcon} label={t.methodTwoStep} href={focusedPaths.twoStep} action={t.manage}>
            {signIn.twoStep ? t.twoStepOn : t.twoStepOff}</Row>
        </ul>
      </> },
    apps: { title: t.connectedApps,
      summary: apps.status !== 'ok' ? common.unavailableTitle : unused ? t.checkupUnusedApps(unused) : t.appsCardBody(apps.items.length),
      body: apps.status !== 'ok' ? unavailable : <>
        {fixes('apps')}
        {apps.items.length ? <ul className="divide-y divide-border/60">
          {apps.items.slice(0, 8).map(app => <li key={app.clientId} className="flex flex-wrap items-baseline gap-x-3 py-2.5">
            <span className="font-medium">{app.name}</span>
            <span className="text-muted-foreground">{app.lastUsed ? t.appLastUsed({ time: app.lastUsed }) : t.appNotUsed}</span>
            {app.unused ? <Badge variant="info" size="sm">{t.checkupAppUnused}</Badge> : null}
          </li>)}
        </ul> : <p className="py-2 text-muted-foreground">{t.appsEmptyBody}</p>}
        <div className="mt-3"><Button variant="outline" asChild><a href={sectionPaths['connected-apps']}>{t.manageApps}</a></Button></div>
      </> },
  };

  return <>
    <SectionHeading back={{ href: sectionPaths.security, label: t.security }} title={t.checkupTitle} intro={t.checkupIntro} />
    <div className="flex flex-col gap-6">
      <section aria-labelledby="checkup-status" className={cn('flex flex-col items-center gap-2 rounded-3xl border px-6 py-8 text-center',
        'shadow-(--aura-shadow-card)', overall === 'ok' ? 'border-success/30 bg-success/6'
          : overall === 'warn' ? 'border-warning/40 bg-warning/8' : overall === 'unknown'
            ? 'border-border/60 bg-muted/30' : 'border-info/30 bg-info/6')}>
        <Status className={cn('size-12', toneColours[overall])} aria-hidden="true" />
        <h2 id="checkup-status" className="text-xl font-semibold">{overall === 'ok' ? t.checkupProtected
          : overall === 'warn' ? t.checkupNeedsAttention(issues.length) : overall === 'unknown'
            ? t.checkupIncomplete : t.checkupRecommendation(issues.length)}</h2>
        <p className="max-w-md text-muted-foreground">{overall === 'ok' ? t.checkupProtectedBody
          : overall === 'unknown' ? t.checkupIncompleteBody : t.checkupReviewBelow}</p>
      </section>
      <div className="rounded-3xl border border-border/60 bg-card shadow-(--aura-shadow-card)">
        <Accordion multiple defaultValue={checkupAreas.filter(area => !readable(area) || areaTone(area, issues) !== 'ok')}>
          {checkupAreas.map(area => {
            const tone = readable(area) ? areaTone(area, issues) : 'unknown';
            const Tone = toneIcons[tone];
            const Icon = areaIcons[area];
            const { title, summary, body } = areas[area];
            return <AccordionItem key={area} value={area} className="border-border/60">
              <AccordionTrigger className="mx-2 gap-4 px-3 py-4 sm:mx-3">
                <span className="flex min-w-0 flex-1 items-center gap-4">
                  <span className="relative grid size-10 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground">
                    <Icon className="size-5" aria-hidden="true" />
                    <Tone className={cn('absolute -end-1 -bottom-1 size-4.5 rounded-full bg-card', toneColours[tone])}
                      aria-hidden="true" /></span>
                  <span className="min-w-0">
                    <span className="block text-base font-semibold">{title}</span>
                    <span className="block font-normal text-muted-foreground">
                      <span className="sr-only">{t.checkupTone[tone]}: </span>{summary}</span>
                  </span>
                </span>
              </AccordionTrigger>
              <AccordionContent className="text-base"><div className="px-2 sm:ps-16">{body}</div></AccordionContent>
            </AccordionItem>;
          })}
        </Accordion>
      </div>
      <div className="flex justify-end"><Button size="lg" asChild><a href={sectionPaths.home}>{t.checkupDone}</a></Button></div>
    </div>
  </>;
}
