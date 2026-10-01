'use client';

import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { FlagIcon } from 'lucide-react';
import LocalizedLink from '../shell/localized-link.tsx';
import { useOptionalShell } from '../shell/shell-provider.tsx';
import { reportHref } from './report.ts';
import { safetyText } from './messages.ts';

const kinds = { profile: 'reportProfile', post: 'reportPost', reply: 'reportReply', work: 'reportWork',
  page: 'reportPage' } as const;
export type ReportKind = keyof typeof kinds;

/**
 * The one way to report something: a link to the report page with the target
 * filled in. It needs no account and no script, so it works signed out and on
 * a page that has not hydrated. Every surface that shows people's
 * contributions places this one component, with the REZICS ID of the target
 * (Main resolves IDs, not this site's page addresses) and what it is.
 *
 * `className` restyles the link to sit in a host's own row of actions; without
 * it the link is a quiet outline button. `iconOnly` keeps the name for assistive
 * technology and the tooltip.
 */
export function ReportAction({ target, kind, realm, iconOnly = false, className, label }: {
  target: string; kind: ReportKind;
  /** The Realm to which the target belongs, so the report can name its rules. */
  realm?: string | null;
  iconOnly?: boolean; className?: string;
  /** Names the target more exactly than its kind, for example "Report this reply by Mei". */
  label?: string;
}) {
  const locale = useOptionalShell()?.locale ?? 'en';
  const name = label ?? safetyText[kinds[kind]][locale];
  return <LocalizedLink href={reportHref(target, realm)} data-report-action={kind} rel="nofollow"
    aria-label={iconOnly ? name : undefined} title={iconOnly ? name : undefined}
    className={cn(className ?? buttonVariants({ variant: 'ghost', size: 'sm' }))}>
    <FlagIcon aria-hidden="true" className="size-3.5" />{iconOnly ? null : name}
  </LocalizedLink>;
}
