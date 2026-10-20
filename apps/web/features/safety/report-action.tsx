'use client';

import { Button, buttonVariants } from '@rezics/ui/button';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@rezics/ui/menu';
import { cn } from '@rezics/ui/utils';
import { EllipsisIcon, FlagIcon } from 'lucide-react';
import type { UiLocale } from '../../i18n/define.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { useOptionalShell } from '../shell/shell-provider.tsx';
import { reportHref, type ReportSelection } from './report.ts';
import { safetyText } from './messages.ts';
import { messages as relationshipMessages } from '../relationships/messages.ts';

const kinds = { profile: 'reportProfile', post: 'reportPost', reply: 'reportReply', work: 'reportWork',
  page: 'reportPage', text: 'reportText', cover: 'reportCover' } as const;
export type ReportKind = keyof typeof kinds;

export interface ReportMenuTarget {
  target: string; kind: ReportKind; realm?: string | null; selection?: ReportSelection; label?: string;
}

/** Report links join the object's existing menu; the exact target and selection survive navigation. */
export function ReportMenuItems({ targets, locale }: { targets: readonly ReportMenuTarget[]; locale: UiLocale }) {
  return targets.map((item, index) => <MenuItem key={`${item.target}:${index}`} value={`report-${index}`} asChild>
    <LocalizedLink href={reportHref(item.target, item.realm, item.selection)} data-report-action={item.kind}
      rel="nofollow"><FlagIcon aria-hidden="true" />{item.label ?? safetyText[kinds[item.kind]][locale]}</LocalizedLink>
  </MenuItem>);
}

/** For objects with no relationship actions. Objects that have them reuse that menu instead. */
export function ReportMenu({ targets, name, locale, moreAccessibleLabel }: {
  targets: readonly ReportMenuTarget[]; name: string; locale: UiLocale; moreAccessibleLabel?: string;
}) {
  if (!targets.length) return null;
  return <Menu>
    <MenuTrigger asChild><Button type="button" variant="ghost" size="icon-sm"
      aria-label={moreAccessibleLabel ?? `${relationshipMessages[locale].options} · ${name}`}><EllipsisIcon aria-hidden="true" /></Button></MenuTrigger>
    <MenuContent className="max-w-[calc(100vw-2rem)]"><ReportMenuItems targets={targets} locale={locale} /></MenuContent>
  </Menu>;
}

/**
 * The one way to report something: a link to the report page with the target
 * filled in. Content pages place report links inside their object's more menu;
 * this link remains available to the reporting workflow itself.
 *
 * `className` restyles the link to sit in a host's own row of actions; without
 * it the link is a quiet outline button. `iconOnly` keeps the name for assistive
 * technology and the tooltip.
 */
export function ReportAction({ target, kind, realm, selection, iconOnly = false, className, label }: {
  target: string; kind: ReportKind;
  /** The Realm to which the target belongs, so the report can name its rules. */
  realm?: string | null;
  selection?: ReportSelection;
  iconOnly?: boolean; className?: string;
  /** Names the target more exactly than its kind, for example "Report this reply by Mei". */
  label?: string;
}) {
  const locale = useOptionalShell()?.locale ?? 'en';
  const name = label ?? safetyText[kinds[kind]][locale];
  return <LocalizedLink href={reportHref(target, realm, selection)} data-report-action={kind} rel="nofollow"
    aria-label={iconOnly ? name : undefined} title={iconOnly ? name : undefined}
    className={cn(className ?? buttonVariants({ variant: 'ghost', size: 'sm' }))}>
    <FlagIcon aria-hidden="true" className="size-3.5" />{iconOnly ? null : name}
  </LocalizedLink>;
}
