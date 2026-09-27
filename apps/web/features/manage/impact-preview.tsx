'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Skeleton } from '@rezics/ui/skeleton';
import { cn } from '@rezics/ui/utils';
import { MinusCircleIcon, PlusCircleIcon, TriangleAlertIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import { agentLabel } from './format.ts';
import type { ManageMessages } from './messages.ts';
import { impactLines, permissionText, removesOwnRoleManagement } from './permissions.ts';
import type { AgentSummary, RoleImpact } from './types.ts';

export type ImpactState =
  | { kind: 'checking' }
  | { kind: 'ready'; impact: RoleImpact; refreshed?: boolean }
  | { kind: 'failed' }
  | { kind: 'idle' };

/**
 * Main's exact preview of a role change in plain words: "2 members gain:
 * Manage members", with the people named. A change can only be saved against
 * the preview it shows (Main checks the preview digest).
 */
export function ImpactPreview({ state, agents, actingSubject, locale, messages }: {
  state: ImpactState; agents: Record<string, AgentSummary>; actingSubject: string;
  locale: UiLocale; messages: ManageMessages;
}) {
  const t = materializeData(messages, { locale });
  if (state.kind === 'idle') return null;
  return <section aria-label={t.impactTitle} aria-live="polite" aria-busy={state.kind === 'checking'}
    className="grid gap-2 rounded-2xl border border-border/60 bg-muted/30 p-4">
    <h3 className="font-medium text-sm">{t.impactTitle}</h3>
    {state.kind === 'checking' ? <div className="grid gap-2" role="status">
      <span className="sr-only">{t.impactChecking}</span>
      <Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-1/2" /></div>
      : state.kind === 'failed' ? <p className="text-destructive-foreground text-sm">{t.impactFailed}</p>
        : <>
          {state.refreshed ? <p className="text-sm text-warning-foreground">{t.impactStale}</p> : null}
          {impactLines(state.impact).length ? <ul className="grid gap-2">
            {impactLines(state.impact).map(line => {
              const permission = t[permissionText[line.permission].name];
              const count = line.members.length;
              const Icon = line.direction === 'gain' ? PlusCircleIcon : MinusCircleIcon;
              return <li key={`${line.direction}-${line.permission}`} className="grid gap-0.5 text-sm">
                <span className={cn('flex items-center gap-2 font-medium',
                  line.direction === 'gain' ? 'text-success-foreground' : 'text-destructive-foreground')}>
                  <Icon aria-hidden="true" className="size-4 shrink-0" />
                  {line.direction === 'gain' ? t.impactGain({ count, permission }) : t.impactLose({ count, permission })}
                </span>
                <span className="ps-6 text-muted-foreground">{line.members.map(member =>
                  agentLabel(agents[member], member, id => t.agentFallback({ id }))).join(', ')}</span>
              </li>;
            })}
          </ul> : <p className="text-sm">{t.impactNone}</p>}
          <p className="text-muted-foreground text-xs">{t.impactExact}</p>
          {removesOwnRoleManagement(state.impact, actingSubject) ? <Alert variant="warning">
            <TriangleAlertIcon aria-hidden="true" />
            <AlertDescription>{t.selfLockout}</AlertDescription>
          </Alert> : null}
        </>}
  </section>;
}
