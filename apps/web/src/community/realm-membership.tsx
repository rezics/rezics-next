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
import { classifyRealmLeaveFailure, realmLeaveReadResolves, type RealmLeaveRecoveryState } from './realm-leave-recovery';
import { RealmLeaveRecovery, type RealmLeaveCheck } from './realm-leave-recovery.tsx';

/** Membership changes affect participation; following always addresses the carrying Space separately. */
export function RealmMembership({
  realm,
  returnTo,
  spaceId,
  memberLabel,
  admittedAction,
}: {
  realm: Pick<RealmHome, 'id' | 'visibility' | 'viewer'>;
  returnTo: string;
  spaceId?: string;
  memberLabel?: string;
  admittedAction?: 'join' | 'leave' | 'sign-in' | null | undefined;
}) {
  const { state: session, csrfToken } = useSession();
  if (session !== 'signed-in') {
    if (admittedAction !== undefined && admittedAction !== 'sign-in') return null;
    if (realm.visibility === 'protected')
      return (
        <section className="rounded-2xl bg-card p-3 text-card-foreground" aria-label={m.realm_membership_label()}>
          <p className="text-sm">{m.realm_protected_admission()}</p>
        </section>
      );
    return (
      <section
        className="rounded-2xl bg-card p-3 text-card-foreground"
        aria-label={m.realm_membership_label()}
        data-member-state="none"
      >
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
  return (
    <PersonalMembership
      key={realm.id}
      realm={realm}
      csrfToken={csrfToken}
      memberLabel={memberLabel}
      admittedAction={admittedAction}
      {...(spaceId ? { spaceId } : {})}
    />
  );
}

function PersonalMembership({
  realm,
  csrfToken,
  spaceId,
  memberLabel,
  admittedAction,
}: {
  realm: Pick<RealmHome, 'id' | 'visibility' | 'viewer'>;
  csrfToken: string | null;
  spaceId?: string;
  memberLabel?: string | undefined;
  admittedAction?: 'join' | 'leave' | 'sign-in' | null | undefined;
}) {
  const client = useQueryClient();
  const router = useRouter();
  const query = useQuery({ ...realmMembershipQuery(realm.id), enabled: personalRead.enabled });
  const [pending, setPending] = useState<{ target?: 'member' | 'none'; cycle: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<MembershipProblem>(null);
  const [refresh, setRefresh] = useState<MembershipRefreshState>(null);
  const [leaveRecovery, setLeaveRecovery] = useState<RealmLeaveRecoveryState | null>(null);
  const [leaveCheck, setLeaveCheck] = useState<RealmLeaveCheck>(null);
  const inFlight = useRef(false);
  const attempt = useRef<{ action: 'join' | 'leave'; idempotencyKey: string } | null>(null);
  const viewer = query.data;

  useEffect(() => {
    if (viewer?.state === 'pending' && !leaveRecovery) setPending((previous) => previous ?? { cycle: 0 });
  }, [viewer?.state, leaveRecovery]);

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

  async function checkLeave() {
    if (!leaveRecovery || inFlight.current || pending) return;
    inFlight.current = true;
    setBusy(true);
    setLeaveCheck('checking');
    try {
      // This query reads both current membership and native participation admission.
      const current = await query.refetch();
      if (current.isError || !current.data) setLeaveCheck('unavailable');
      else if (realmLeaveReadResolves(leaveRecovery, current.data.state)) {
        await Promise.all([
          client.invalidateQueries({ queryKey: ['my-realms'] }),
          ...(spaceId ? [client.invalidateQueries({ queryKey: ['follow-state', spaceId] })] : []),
          router.invalidate(),
        ]);
        attempt.current = null;
        setLeaveRecovery(null);
        setLeaveCheck(null);
      } else setLeaveCheck('unchanged');
    } catch {
      setLeaveCheck('unavailable');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function change(action: 'join' | 'leave', retryLeave = false) {
    if (
      !viewer ||
      !csrfToken ||
      inFlight.current ||
      pending ||
      query.isFetching ||
      query.isError ||
      query.isPending ||
      (leaveRecovery && !(retryLeave && action === 'leave' && leaveRecovery.kind === 'uncertain')) ||
      (action === 'join' && realm.visibility === 'protected') ||
      (admittedAction !== undefined && admittedAction !== action)
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    setLeaveCheck(null);
    const input =
      attempt.current?.action === action ? attempt.current : { action, idempotencyKey: viewer.idempotencyKey };
    attempt.current = input;
    try {
      const result = await changeRealmMembership({
        data: { realmId: realm.id, ...input },
        headers: { 'X-CSRF-Token': csrfToken },
      });
      if (result.outcome === 'accepted') {
        setLeaveRecovery(null);
        setRefresh('checking');
        setPending({ target: action === 'join' ? 'member' : 'none', cycle: 0 });
      } else if (action === 'leave') setLeaveRecovery(classifyRealmLeaveFailure(result));
      else setProblem(result);
    } catch {
      if (action === 'leave') setLeaveRecovery(classifyRealmLeaveFailure({ outcome: 'refused' }));
      else setProblem({ outcome: 'refused' });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <>
    <RealmParticipationView
      memberLabel={memberLabel}
      admittedAction={admittedAction}
      state={
        pending
          ? 'pending'
          : leaveRecovery && viewer
            ? viewer.state
          : query.isPending || query.isFetching
            ? 'loading'
            : query.isError || !viewer
              ? 'unavailable'
              : viewer.state
      }
      visibility={realm.visibility}
      busy={busy}
      ready={!!csrfToken && !leaveRecovery}
      refresh={refresh}
      problem={problem}
      onChange={(action) => void change(action)}
      onRetry={() => (leaveRecovery ? void checkLeave() : pending ? setPending({ ...pending, cycle: pending.cycle + 1 }) : void query.refetch())}
    />
    {leaveRecovery ? (
      <RealmLeaveRecovery
        key={leaveRecovery.kind}
        realmId={realm.id}
        recovery={leaveRecovery}
        check={leaveCheck}
        busy={busy}
        ready={!!csrfToken && !query.isError && !query.isFetching}
        onCheck={() => void checkLeave()}
        onRetry={() => void change('leave', true)}
      />
    ) : null}
    </>
  );
}
