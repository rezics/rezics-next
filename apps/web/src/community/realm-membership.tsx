import { Button } from '@rezics/ui/shadcn/button';
import { Badge } from '@rezics/ui/shadcn/badge';
import { useEffect, useState } from 'react';
import { m } from '../paraglide/messages.js';
import type { MemberState, RealmHome } from './space';
import { changeRealmMembership } from './space-actions';

function csrfHeaders(): HeadersInit {
  const token = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? '';
  return { 'X-CSRF-Token': token };
}

type Problem = 'closed' | 'refused' | null;

/** The viewer's standing in a Realm and the one write that changes it. */
export function RealmMembership({ realm, returnTo }: { realm: RealmHome; returnTo: string }) {
  const viewer = realm.viewer;
  const [state, setState] = useState<MemberState>(viewer?.state ?? 'none');
  const [hydrated, setHydrated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem>(null);
  useEffect(() => setHydrated(true), []);
  useEffect(() => setState(viewer?.state ?? 'none'), [viewer?.state]);

  async function change(action: 'join' | 'leave') {
    if (!viewer || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await changeRealmMembership({
        data: { realmId: realm.id, action, idempotencyKey: viewer.idempotencyKey },
        headers: csrfHeaders(),
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

  if (!viewer)
    return (
      <section aria-label={m.realm_membership_label()} className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button render={<a href={`/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`} />}>
            {m.realm_join()}
          </Button>
        </div>
      </section>
    );

  return (
    <section aria-label={m.realm_membership_label()} data-member-state={state} className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        {state === 'member' ? (
          <>
            <Badge>{m.realm_state_member()}</Badge>
            <Button type="button" variant="outline" disabled={!hydrated || busy} onClick={() => void change('leave')}>
              {m.realm_leave()}
            </Button>
          </>
        ) : null}
        {state === 'none' ? (
          <Button type="button" disabled={!hydrated || busy} onClick={() => void change('join')}>
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
