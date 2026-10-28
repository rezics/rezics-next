import { useSession } from '../session/query';
import { Button } from '@rezics/ui/shadcn/button';
import { Badge } from '@rezics/ui/shadcn/badge';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { personalRead } from '../kernel/query';
import { m } from '../paraglide/messages.js';
import type { MemberState, RealmHome } from './space';
import { changeRealmMembership } from './space-actions';
import { realmMembershipQuery } from './realm-membership-queries';

type Problem = 'closed' | 'refused' | null;

/** The viewer's standing in a Realm and the one write that changes it. */
export function RealmMembership({ realm, returnTo }: { realm: RealmHome; returnTo: string }) {
  const { state: session, csrfToken } = useSession();
  if (session !== 'signed-in' && realm.viewer?.state === 'none')
    return (
      <section aria-label={m.realm_membership_label()} data-member-state="none" className="min-h-16 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button">{m.realm_join()}</Button>
        </div>
      </section>
    );
  if (session !== 'signed-in')
    return (
      <section aria-label={m.realm_membership_label()} className="min-h-16 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button render={<a href={`/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`} />}>
            {m.realm_join()}
          </Button>
        </div>
      </section>
    );
  return <PersonalMembership realm={realm} csrfToken={csrfToken} returnTo={returnTo} />;
}

function PersonalMembership({
  realm,
  csrfToken,
  returnTo,
}: {
  realm: RealmHome;
  csrfToken: string | null;
  returnTo: string;
}) {
  const { data: viewer, isPending } = useQuery({
    ...realmMembershipQuery(realm.id),
    enabled: personalRead.enabled,
  });
  const [state, setState] = useState<MemberState>(viewer?.state ?? 'none');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem>(null);
  useEffect(() => setState(viewer?.state ?? 'none'), [viewer?.state]);

  async function change(action: 'join' | 'leave') {
    if (!viewer || !csrfToken || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await changeRealmMembership({
        data: { realmId: realm.id, action, idempotencyKey: viewer.idempotencyKey },
        headers: { 'X-CSRF-Token': csrfToken },
      });
      if (result.outcome === 'accepted') setState('pending');
      else setProblem(result.outcome);
    } catch {
      setProblem('refused');
    } finally {
      setBusy(false);
    }
  }

  const protectedNote =
    realm.visibility === 'protected' ? (
      <p data-visibility="protected" className="text-sm text-muted-foreground">
        {m.realm_protected_note()}
      </p>
    ) : null;

  if (isPending) return <section aria-label={m.realm_membership_label()} className="min-h-16" aria-busy="true" />;

  if (!viewer)
    return (
      <section aria-label={m.realm_membership_label()} className="min-h-16 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button render={<a href={`/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`} />}>
            {m.realm_join()}
          </Button>
        </div>
      </section>
    );

  return (
    <section aria-label={m.realm_membership_label()} data-member-state={state} className="min-h-16 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        {state === 'member' ? (
          <>
            <Badge>{m.realm_state_member()}</Badge>
            <Button type="button" variant="outline" disabled={!csrfToken || busy} onClick={() => void change('leave')}>
              {m.realm_leave()}
            </Button>
          </>
        ) : null}
        {state === 'none' ? (
          <Button type="button" disabled={!csrfToken || busy} onClick={() => void change('join')}>
            {m.realm_join()}
          </Button>
        ) : null}
        {state === 'pending' ? (
          <>
            <Badge variant="secondary">{m.realm_state_pending()}</Badge>
            <span className="text-sm text-muted-foreground">{m.realm_state_pending_note()}</span>
          </>
        ) : null}
      </div>
      {state === 'banned' ? <p className="max-w-prose">{m.realm_banned()}</p> : null}
      {problem ? (
        <p role="status" className="text-sm text-destructive">
          {problem === 'closed' ? m.realm_change_closed() : m.realm_change_failed()}
        </p>
      ) : null}
      {protectedNote}
    </section>
  );
}
