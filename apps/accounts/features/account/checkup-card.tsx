'use client';

import { Button } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { CircleAlertIcon, InfoIcon, type LucideIcon, MailWarningIcon, ShieldAlertIcon, ShieldPlusIcon } from 'lucide-react';
import type { CheckupIssue } from './activity.ts';
import { useTranslation } from '../../i18n/client.ts';

const urgent = new Set<CheckupIssue>(['verify-email', 'failed-sign-ins']);
const icons: Record<CheckupIssue, LucideIcon> = { 'verify-email': MailWarningIcon,
  'failed-sign-ins': ShieldAlertIcon, 'add-second-step': ShieldPlusIcon };
const actions: Record<CheckupIssue, string> = { 'verify-email': '/personal-info',
  'failed-sign-ins': '/security/activity', 'add-second-step': '/security/passkeys' };

/** The one status card the account centre shows, and only when something
 * needs doing: colour, icon and words all say how urgent it is. */
export function CheckupCard({ issues, failedSignIns = 0, headingLevel = 2 }: { issues: CheckupIssue[];
  failedSignIns?: number; headingLevel?: 2 | 3 }) {
  const { t } = useTranslation('account');
  if (!issues.length) return null;
  const warn = issues.some(issue => urgent.has(issue));
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const Tone = warn ? CircleAlertIcon : InfoIcon;
  const copy = (issue: CheckupIssue) => issue === 'verify-email' ? [t.checkupVerifyEmail, t.checkupVerifyEmailBody, t.checkupVerifyEmailAction]
    : issue === 'failed-sign-ins' ? [t.checkupFailedSignIns(failedSignIns), t.checkupFailedSignInsBody, t.checkupFailedSignInsAction]
      : [t.checkupSecondStep, t.checkupSecondStepBody, t.checkupSecondStepAction];
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
        const [title, body, action] = copy(issue);
        return <li key={issue} className="flex flex-col gap-3 rounded-2xl bg-card p-4 sm:flex-row sm:items-center">
          <Icon className={cn('size-5 shrink-0 max-sm:hidden', urgent.has(issue) ? 'text-warning-foreground' : 'text-info-foreground')}
            aria-hidden="true" />
          <div className="min-w-0 flex-1"><p className="font-medium">{title}</p>
            <p className="text-sm text-muted-foreground">{body}</p></div>
          <Button variant="outline" asChild className="shrink-0"><a href={actions[issue]}>{action}</a></Button>
        </li>;
      })}
    </ul>
  </section>;
}
