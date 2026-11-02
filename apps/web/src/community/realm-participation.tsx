import { useId } from 'react';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { ListRowControl } from '@rezics/ui/list-row';
import { Button } from '@rezics/ui/shadcn/button';
import { Badge } from '@rezics/ui/shadcn/badge';
import { m } from '../paraglide/messages.js';
import type { MemberState, MembershipResult, RealmHome } from './space';

export type MembershipProblem = Exclude<MembershipResult, { outcome: 'accepted' }> | null;
export type MembershipRefreshState = 'checking' | 'pending' | 'unavailable' | null;

/** Realm standing has no shadcn equivalent; compose its Badge and Button controls. */
export function RealmParticipationView({
  state,
  visibility,
  busy = false,
  ready = true,
  refresh = null,
  problem = null,
  onChange,
  onRetry,
  memberLabel,
  admittedAction,
}: {
  state: MemberState | 'loading' | 'unavailable';
  visibility: RealmHome['visibility'];
  busy?: boolean;
  ready?: boolean;
  refresh?: MembershipRefreshState;
  problem?: MembershipProblem;
  onChange: (action: 'join' | 'leave') => void;
  onRetry: () => void;
  memberLabel?: string | undefined;
  admittedAction?: 'join' | 'leave' | 'sign-in' | null | undefined;
}) {
  const headingId = useId();
  const pending = state === 'pending';
  return (
    <section
      className="min-w-0"
      aria-labelledby={headingId}
      data-member-state={state}
      aria-busy={busy || refresh === 'checking'}
    >
      <ContentItemFrame as="div" className="min-w-0 space-y-4 p-4 text-start [overflow-wrap:anywhere]">
        <ContentItemHeading id={headingId} className="text-lg leading-snug font-semibold sm:text-xl">
          {m.realm_membership_label()}
        </ContentItemHeading>
        <div data-content-item-slot="state" className="min-w-0 space-y-2 empty:hidden">
          {pending ? (
            <Badge variant="secondary" className="h-auto max-w-full whitespace-normal py-1 text-start">
              {m.realm_state_pending()}
            </Badge>
          ) : null}
          {state === 'loading' ? (
            <p role="status" className="text-sm leading-relaxed text-muted-foreground">
              {m.realm_membership_loading()}
            </p>
          ) : null}
          {pending ? (
            <p role="status" className="max-w-prose text-sm leading-relaxed text-muted-foreground">
              {refresh === 'checking'
                ? problem
                  ? m.realm_membership_loading()
                  : m.realm_membership_checking()
                : problem
                  ? m.realm_membership_current_pending()
                  : refresh === 'unavailable'
                    ? m.realm_membership_pending_unavailable()
                    : m.realm_membership_still_pending()}
            </p>
          ) : null}
          {state === 'unavailable' ? (
            <p role="status" className="text-sm leading-relaxed text-muted-foreground">
              {m.realm_membership_unavailable()}
            </p>
          ) : null}
          {problem?.outcome === 'closed' && refresh === 'unavailable' && state !== 'unavailable' ? (
            <p role="status" className="text-sm leading-relaxed text-muted-foreground">
              {m.realm_membership_unavailable()}
            </p>
          ) : null}
          {state === 'banned' && !problem ? (
            <p role="status" className="max-w-prose leading-relaxed">
              {m.realm_banned()}
            </p>
          ) : null}
          {problem ? (
            <p role="alert" className="max-w-prose text-sm leading-relaxed text-destructive">
              {problem.outcome === 'closed' ? m.realm_change_closed() : m.realm_change_failed()}
            </p>
          ) : null}
          {visibility === 'protected' ? (
            <p data-visibility="protected" className="max-w-prose text-sm leading-relaxed text-muted-foreground">
              {state === 'member' && !problem ? m.realm_protected_note() : m.realm_protected_admission()}
            </p>
          ) : null}
        </div>
        <ListRowControl
          data-content-item-slot="actions"
          className="flex min-w-0 flex-wrap items-center gap-3 empty:hidden"
        >
          {state === 'member' && !problem ? (
            <>
              <Badge className="h-auto max-w-full whitespace-normal py-1 text-start">
                {memberLabel ?? m.realm_state_member()}
              </Badge>
              {admittedAction === undefined || admittedAction === 'leave' ? (
                <Button
                  size="lg"
                  type="button"
                  variant="outline"
                  className="h-auto min-h-11 min-w-11 max-w-full bg-background px-6 py-2 text-start text-base whitespace-normal text-foreground dark:bg-background"
                  disabled={!ready || busy}
                  onClick={() => onChange('leave')}
                >
                  {m.realm_leave()}
                </Button>
              ) : null}
            </>
          ) : null}
          {state === 'none' &&
          !problem &&
          visibility === 'public' &&
          (admittedAction === undefined || admittedAction === 'join') ? (
            <Button
              size="lg"
              type="button"
              className="h-auto min-h-11 min-w-11 max-w-full px-6 py-2 text-start text-base whitespace-normal"
              disabled={!ready || busy}
              onClick={() => onChange('join')}
            >
              {m.realm_join()}
            </Button>
          ) : null}
          {problem || state === 'unavailable' || (pending && refresh !== 'checking') ? (
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-11 min-w-11 max-w-full bg-background py-2 text-start whitespace-normal text-foreground dark:bg-background"
              disabled={busy || refresh === 'checking' || (problem?.outcome === 'closed' && !ready)}
              onClick={onRetry}
            >
              {m.realm_membership_retry()}
            </Button>
          ) : null}
        </ListRowControl>
      </ContentItemFrame>
    </section>
  );
}
