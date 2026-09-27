'use client';

import { Button } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { CircleAlertIcon, LockKeyholeIcon, LogInIcon, SearchXIcon, SparklesIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useAccountClient } from '../api/account-client.tsx';
import { useTranslation } from '../../i18n/client.ts';

const icons = { signedOut: LogInIcon, stale: LockKeyholeIcon, unavailable: CircleAlertIcon,
  missing: SparklesIcon, notFound: SearchXIcon };

/** A full-width state message: signed out, needs re-authentication,
 * unavailable, not available yet, not found or empty. */
export function StatePanel({ icon, title, body, action, className, headingLevel = 2 }: {
  icon: keyof typeof icons; title: string; body: ReactNode; action?: ReactNode; className?: string;
  headingLevel?: 1 | 2 }) {
  const Icon = icons[icon];
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  return <section className={cn('flex flex-col items-center gap-3 rounded-3xl border border-border/60 bg-card px-6 py-12 text-center shadow-(--aura-shadow-card)', className)}>
    <span className="grid size-12 place-items-center rounded-full bg-accent text-accent-foreground">
      <Icon className="size-6" aria-hidden="true" /></span>
    <Heading className="text-xl font-semibold">{title}</Heading>
    <p className="max-w-md text-muted-foreground">{body}</p>
    {action ? <div className="mt-2">{action}</div> : null}
  </section>;
}

export function signInHref(next: string, reauth = false): string {
  return `/sign-in?${new URLSearchParams({ next, ...(reauth ? { reauth: '1' } : {}) })}`;
}

/** The standard panel for a server read that did not return data. */
export function ReadStatePanel({ status, next, headingLevel }: {
  status: 'signed-out' | 'stale' | 'unavailable' | 'missing'; next: string; headingLevel?: 1 | 2 }) {
  const { t } = useTranslation('common');
  const { refresh } = useAccountClient();
  if (status === 'signed-out') {
    return <StatePanel icon="signedOut" title={t.signedOutTitle} body={t.signedOutBody} headingLevel={headingLevel}
      action={<Button asChild size="lg"><a href={signInHref(next)}>{t.signIn}</a></Button>} />;
  }
  if (status === 'stale') {
    return <StatePanel icon="stale" title={t.staleTitle} body={t.staleBody} headingLevel={headingLevel}
      action={<Button asChild size="lg"><a href={signInHref(next, true)}>{t.confirmIdentity}</a></Button>} />;
  }
  if (status === 'missing') {
    return <StatePanel icon="missing" title={t.notAvailableYet} body={t.comingSoon} headingLevel={headingLevel} />;
  }
  return <StatePanel icon="unavailable" title={t.unavailableTitle} body={t.unavailableBody} headingLevel={headingLevel}
    action={<Button variant="outline" size="lg" onClick={refresh}>{t.retry}</Button>} />;
}
