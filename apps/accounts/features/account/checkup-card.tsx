'use client';

import { Button } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { AppWindowIcon, ChevronRightIcon, CircleAlertIcon, InfoIcon, type LucideIcon, MailWarningIcon, ShieldAlertIcon,
  ShieldCheckIcon, ShieldPlusIcon } from 'lucide-react';
import { type CheckupIssue, urgentIssues } from './activity.ts';
import { focusedPaths, sectionPaths } from './sections.ts';
import { useTranslation } from '../../i18n/client.ts';

const icons: Record<CheckupIssue, LucideIcon> = { 'verify-email': MailWarningIcon,
  'failed-sign-ins': ShieldAlertIcon, 'add-second-step': ShieldPlusIcon, 'unused-apps': AppWindowIcon };
export const issueActions: Record<CheckupIssue, string> = { 'verify-email': sectionPaths['personal-info'],
  'failed-sign-ins': focusedPaths.activity, 'add-second-step': focusedPaths.passkeys,
  'unused-apps': sectionPaths['connected-apps'] };

/** Title, explanation and action label of one checkup issue. */
export function useIssueCopy() {
  const { t } = useTranslation('account');
  return (issue: CheckupIssue, counts: { failedSignIns: number; unusedApps: number }): [string, string, string] =>
    issue === 'verify-email' ? [t.checkupVerifyEmail, t.checkupVerifyEmailBody, t.checkupVerifyEmailAction]
      : issue === 'failed-sign-ins' ? [t.checkupFailedSignIns(counts.failedSignIns), t.checkupFailedSignInsBody,
        t.checkupFailedSignInsAction]
        : issue === 'unused-apps' ? [t.checkupUnusedApps(counts.unusedApps), t.checkupUnusedAppsBody, t.checkupUnusedAppsAction]
          : [t.checkupSecondStep, t.checkupSecondStepBody, t.checkupSecondStepAction];
}

/** The account's status, as Google Account's home shows it: a short "protected"
 * line when nothing needs doing, otherwise each issue with its fix. Colour,
 * icon and words all say how urgent it is; both lead to the Security Checkup. */
export function CheckupCard({ issues, complete = true, failedSignIns = 0, unusedApps = 0, headingLevel = 2 }: {
  issues: CheckupIssue[]; complete?: boolean; failedSignIns?: number; unusedApps?: number; headingLevel?: 2 | 3 }) {
  const { t } = useTranslation('account');
  const copy = useIssueCopy();
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const checkup = <Button variant="link" className="h-auto px-0" asChild><a href={focusedPaths.checkup}>
    {issues.length ? t.openCheckup : t.checkupDetails}<ChevronRightIcon aria-hidden="true" /></a></Button>;
  if (!issues.length) {
    return <section aria-labelledby="checkup-title" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-3xl border
      border-border/60 bg-card px-5 py-4 shadow-(--aura-shadow-card) sm:px-6">
      {complete ? <ShieldCheckIcon className="size-6 shrink-0 text-success-foreground" aria-hidden="true" />
        : <InfoIcon className="size-6 shrink-0 text-muted-foreground" aria-hidden="true" />}
      <div className="min-w-0 flex-1">
        <Heading id="checkup-title" className="font-semibold">{complete ? t.checkupProtected : t.checkupIncomplete}</Heading>
        <p className="text-sm text-muted-foreground">{complete ? t.checkupProtectedBody : t.checkupIncompleteBody}</p>
      </div>
      {checkup}
    </section>;
  }
  const warn = issues.some(issue => urgentIssues.has(issue));
  const Tone = warn ? CircleAlertIcon : InfoIcon;
  return <section aria-labelledby="checkup-title" className={cn('rounded-3xl border p-5 shadow-(--aura-shadow-card) sm:p-6',
    warn ? 'border-warning/40 bg-warning/8' : 'border-info/30 bg-info/6')}>
    <div className="flex items-center gap-3">
      <Tone className={cn('size-6 shrink-0', warn ? 'text-warning-foreground' : 'text-info-foreground')} aria-hidden="true" />
      <Heading id="checkup-title" className="text-lg font-semibold">
        {warn ? t.checkupNeedsAttention(issues.length) : t.checkupRecommendation(issues.length)}</Heading>
    </div>
    <ul className="mt-4 flex flex-col gap-3">
      {issues.map(issue => {
        const Icon = icons[issue];
        const [title, body, action] = copy(issue, { failedSignIns, unusedApps });
        return <li key={issue} className="flex flex-col gap-3 rounded-2xl bg-card p-4 sm:flex-row sm:items-center">
          <Icon className={cn('size-5 shrink-0 max-sm:hidden', urgentIssues.has(issue) ? 'text-warning-foreground' : 'text-info-foreground')}
            aria-hidden="true" />
          <div className="min-w-0 flex-1"><p className="font-medium">{title}</p>
            <p className="text-sm text-muted-foreground">{body}</p></div>
          <Button variant="outline" asChild className="shrink-0"><a href={issueActions[issue]}>{action}</a></Button>
        </li>;
      })}
    </ul>
    <div className="mt-3">{checkup}</div>
  </section>;
}
