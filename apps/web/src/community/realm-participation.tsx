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
}) {
  const pending = state === 'pending';
  return (
    <section
      aria-label={m.realm_membership_label()}
      data-member-state={state}
      aria-busy={busy || refresh === 'checking'}
    >
      <div className="flex flex-wrap items-center gap-3">
        {state === 'member' ? (
          <>
            <Badge>{memberLabel ?? m.realm_state_member()}</Badge>
            <Button
              size="lg"
              type="button"
              variant="outline"
              className="h-11 px-6 text-base text-foreground"
              disabled={!ready || busy}
              onClick={() => onChange('leave')}
            >
              {m.realm_leave()}
            </Button>
          </>
        ) : null}
        {state === 'none' && visibility === 'public' ? (
          <Button
            size="lg"
            type="button"
            className="h-11 px-6 text-base"
            disabled={!ready || busy}
            onClick={() => onChange('join')}
          >
            {m.realm_join()}
          </Button>
        ) : null}
        {pending ? <Badge variant="secondary">{m.realm_state_pending()}</Badge> : null}
        {state === 'unavailable' || (pending && refresh !== 'checking') ? (
          <Button type="button" variant="outline" disabled={busy} onClick={onRetry}>
            {m.realm_membership_retry()}
          </Button>
        ) : null}
      </div>
      {state === 'loading' ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.realm_membership_loading()}
        </p>
      ) : null}
      {pending ? (
        <p role="status" className="max-w-prose text-sm text-muted-foreground">
          {refresh === 'checking'
            ? m.realm_membership_checking()
            : refresh === 'unavailable'
              ? m.realm_membership_pending_unavailable()
              : m.realm_membership_still_pending()}
        </p>
      ) : null}
      {state === 'unavailable' ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.realm_membership_unavailable()}
        </p>
      ) : null}
      {state === 'banned' ? (
        <p role="status" className="max-w-prose">
          {m.realm_banned()}
        </p>
      ) : null}
      {problem ? (
        <p role="alert" className="max-w-prose text-sm text-destructive">
          {problem.outcome === 'closed' ? m.realm_change_closed() : (problem.detail ?? m.realm_change_failed())}
        </p>
      ) : null}
      {visibility === 'protected' ? (
        <p data-visibility="protected" className="max-w-prose text-sm text-muted-foreground">
          {state === 'member' ? m.realm_protected_note() : m.realm_protected_admission()}
        </p>
      ) : null}
    </section>
  );
}
