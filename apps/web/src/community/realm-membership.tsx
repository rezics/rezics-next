import { useSession } from '../session/query';
import { Button } from '@rezics/ui/shadcn/button';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { personalRead } from '../kernel/query';
import { m } from '../paraglide/messages.js';
import type { RealmHome } from './space';
import { RealmParticipationView, type MembershipProblem, type MembershipRefreshState } from './realm-participation';
import { changeRealmMembership } from './space-actions';
import { realmMembershipQuery, refreshRealmMembership } from './realm-membership-queries';

/** Membership changes affect participation; following always addresses the carrying Space separately. */
export function RealmMembership({
  realm,
  returnTo,
  spaceId,
}: {
  realm: RealmHome;
  returnTo: string;
  spaceId?: string;
}) {
  const { state: session, csrfToken } = useSession();
  if (session !== 'signed-in') {
    if (realm.visibility === 'protected')
      return (
        <section aria-label={m.realm_membership_label()}>
          <p className="text-sm">{m.realm_protected_admission()}</p>
        </section>
      );
    return (
      <section aria-label={m.realm_membership_label()} data-member-state="none">
        <div className="flex flex-wrap items-center gap-3">
          {realm.viewer?.state === 'none' ? (
            <Button type="button" size="lg" className="h-11 px-6 text-base">
              {m.realm_join()}
            </Button>
          ) : (
            <Button
              size="lg"
              className="h-11 px-6 text-base"
              render={<a href={`/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`} />}
            >
              {m.realm_join()}
            </Button>
          )}
        </div>
      </section>
    );
  }
  return <PersonalMembership key={realm.id} realm={realm} csrfToken={csrfToken} {...(spaceId ? { spaceId } : {})} />;
}

function PersonalMembership({
  realm,
  csrfToken,
  spaceId,
}: {
  realm: RealmHome;
  csrfToken: string | null;
  spaceId?: string;
}) {
  const client = useQueryClient();
  const router = useRouter();
  const query = useQuery({ ...realmMembershipQuery(realm.id), enabled: personalRead.enabled });
  const [pending, setPending] = useState<{ target?: 'member' | 'none'; cycle: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<MembershipProblem>(null);
  const [refresh, setRefresh] = useState<MembershipRefreshState>(null);
  const inFlight = useRef(false);
  const attempt = useRef<{ action: 'join' | 'leave'; idempotencyKey: string } | null>(null);
  const viewer = query.data;

  useEffect(() => {
    if (viewer?.state === 'pending') setPending((previous) => previous ?? { cycle: 0 });
  }, [viewer?.state]);

  useEffect(() => {
    if (!pending) return;
    const controller = new AbortController();
    setRefresh('checking');
    void refreshRealmMembership(
      async () => {
        const result = await client.fetchQuery(realmMembershipQuery(realm.id));
        return result;
      },
      pending.target,
      { signal: controller.signal },
    ).then(async (result) => {
      if (controller.signal.aborted || result.kind === 'cancelled') return;
      if (result.kind === 'settled' || result.kind === 'denied') {
        setPending(null);
        setRefresh(null);
        attempt.current = null;
        await Promise.all([
          client.invalidateQueries({ queryKey: ['my-realms'] }),
          ...(spaceId ? [client.invalidateQueries({ queryKey: ['follow-state', spaceId] })] : []),
          router.invalidate(),
        ]);
      } else setRefresh(result.kind);
    });
    return () => controller.abort();
  }, [pending, client, realm.id, router, spaceId]);

  async function change(action: 'join' | 'leave') {
    if (!viewer || !csrfToken || inFlight.current || pending || (action === 'join' && realm.visibility === 'protected'))
      return;
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    const input =
      attempt.current?.action === action ? attempt.current : { action, idempotencyKey: viewer.idempotencyKey };
    attempt.current = input;
    try {
      const result = await changeRealmMembership({
        data: { realmId: realm.id, ...input },
        headers: { 'X-CSRF-Token': csrfToken },
      });
      if (result.outcome === 'accepted') {
        setRefresh('checking');
        setPending({ target: action === 'join' ? 'member' : 'none', cycle: 0 });
      } else setProblem(result);
    } catch {
      setProblem({ outcome: 'refused' });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <RealmParticipationView
      state={
        pending ? 'pending' : query.isPending ? 'loading' : query.isError || !viewer ? 'unavailable' : viewer.state
      }
      visibility={realm.visibility}
      busy={busy}
      ready={!!csrfToken}
      refresh={refresh}
      problem={problem}
      onChange={(action) => void change(action)}
      onRetry={() => (pending ? setPending({ ...pending, cycle: pending.cycle + 1 }) : void query.refetch())}
    />
  );
}
