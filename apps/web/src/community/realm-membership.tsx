import { useSession } from '../session/query';
import { Button } from '@rezics/ui/shadcn/button';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import type { RealmHome } from './space';
import { RealmParticipationView, type MembershipProblem, type MembershipRefreshState } from './realm-participation';
import { changeRealmMembership } from './space-actions';
import { realmMembershipQuery, refreshRealmMembership } from './realm-membership-queries';
import {
  hasCurrentRealmMembership,
  useRealmMembershipCaller,
  type RealmMembershipCaller,
} from './realm-membership-lifetime';
import {
  classifyRealmLeaveFailure,
  realmLeaveReadResolves,
  type RealmLeaveRecoveryState,
} from './realm-leave-recovery';
import { RealmLeaveRecovery, type RealmLeaveCheck } from './realm-leave-recovery.tsx';

type MembershipOperation = {
  caller: RealmMembershipCaller;
  kind: 'command' | 'check';
  action?: 'join' | 'leave';
  focus: MembershipFocus | null;
};

type MembershipFocus = {
  caller: RealmMembershipCaller;
  control: HTMLElement;
  cancel: () => void;
};

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
  const { state: session, csrfToken, subject } = useSession();
  if (session === 'unknown' || session === 'unavailable') return null;
  if (session === 'signed-out') {
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
          <Button
            size="lg"
            className="h-11 px-6 text-base"
            render={<a href={`/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`} />}
          >
            {m.realm_join()}
          </Button>
        </div>
      </section>
    );
  }
  if (!subject) return null;
  return (
    <PersonalMembership
      key={`${realm.id}:${subject}`}
      realm={realm}
      subject={subject}
      csrfToken={csrfToken}
      memberLabel={memberLabel}
      admittedAction={admittedAction}
      {...(spaceId ? { spaceId } : {})}
    />
  );
}

function PersonalMembership({
  realm,
  subject,
  csrfToken,
  spaceId,
  memberLabel,
  admittedAction,
}: {
  realm: Pick<RealmHome, 'id' | 'visibility' | 'viewer'>;
  subject: string;
  csrfToken: string | null;
  spaceId?: string;
  memberLabel?: string | undefined;
  admittedAction?: 'join' | 'leave' | 'sign-in' | null | undefined;
}) {
  const client = useQueryClient();
  const router = useRouter();
  const caller = useRealmMembershipCaller(client, realm.id, subject, csrfToken);
  const query = useQuery(realmMembershipQuery(realm.id, subject, caller));
  const [pending, setPending] = useState<{
    target?: 'member' | 'none' | undefined;
    cycle: number;
    caller: RealmMembershipCaller;
    focus?: MembershipFocus | null;
  } | null>(null);
  const [busy, setBusy] = useState<{ value: boolean; caller: RealmMembershipCaller } | null>(null);
  const [problem, setProblem] = useState<MembershipProblem>(null);
  const [refresh, setRefresh] = useState<{
    value: MembershipRefreshState;
    caller: RealmMembershipCaller;
  } | null>(null);
  const [leaveRecovery, setLeaveRecovery] = useState<RealmLeaveRecoveryState | null>(null);
  const [leaveCheck, setLeaveCheck] = useState<{
    value: RealmLeaveCheck;
    caller: RealmMembershipCaller;
  } | null>(null);
  const inFlight = useRef<MembershipOperation | null>(null);
  const attempt = useRef<{ action: 'join' | 'leave'; idempotencyKey: string; csrfToken: string } | null>(null);
  const previousCaller = useRef(caller);
  const initialAuthority = useRef({ store: caller.store, revision: caller.revision });
  const summary = useRef<HTMLElement>(null);
  const activation = useRef<HTMLElement | null>(null);
  const resultFocus = useRef<MembershipFocus | null>(null);
  const [settledFocus, setSettledFocus] = useState<MembershipFocus | null>(null);
  const standingIsCurrent = hasCurrentRealmMembership(client, realm.id, subject, caller);
  const viewer = standingIsCurrent ? query.data : undefined;
  const currentPending = pending?.caller.isCurrent() ? pending : null;
  const currentBusy = busy?.caller.isCurrent() ? busy.value : false;
  const currentProblem = viewer || problem?.outcome === 'closed' ? problem : null;
  const currentRecovery = viewer ? leaveRecovery : null;
  const currentRefresh = refresh?.caller.isCurrent() ? refresh.value : null;
  const currentLeaveCheck = leaveCheck?.caller.isCurrent() ? leaveCheck.value : null;

  // Only the explicit operation may carry keyboard position through its existing settlement path.
  function captureActivation(event: MouseEvent<HTMLDivElement>) {
    resultFocus.current?.cancel();
    const control = (event.target as HTMLElement).closest<HTMLElement>('button');
    activation.current =
      event.detail === 0 && control?.ownerDocument.activeElement === control ? control : null;
  }

  function startResultFocus(owner: RealmMembershipCaller) {
    resultFocus.current?.cancel();
    const control = activation.current;
    activation.current = null;
    setSettledFocus(null);
    if (!control || !owner.isCurrent()) return null;
    const document = control.ownerDocument;
    const cancel = () => {
      if (resultFocus.current === handoff) resultFocus.current = null;
      document.removeEventListener('focusin', onFocus, true);
      document.removeEventListener('focusout', onBlur, true);
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('keydown', onKey, true);
    };
    const onFocus = (event: FocusEvent) => {
      if (event.target !== control) cancel();
    };
    const onBlur = (event: FocusEvent) => {
      // Removing or disabling the source is part of the transition, not a user focus move.
      if (event.target !== control) return;
      if (event.relatedTarget) cancel();
      else queueMicrotask(() => {
        if (control.isConnected && !control.hasAttribute('disabled') && document.activeElement !== control) cancel();
      });
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Tab') cancel();
    };
    const handoff = { caller: owner, control, cancel };
    resultFocus.current = handoff;
    document.addEventListener('focusin', onFocus, true);
    document.addEventListener('focusout', onBlur, true);
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('keydown', onKey, true);
    return handoff;
  }

  useEffect(() => () => resultFocus.current?.cancel(), [caller]);

  useEffect(() => {
    const handoff = resultFocus.current;
    if (!handoff) return;
    if (handoff.caller !== caller || !handoff.caller.isCurrent()) {
      handoff.cancel();
      return;
    }
    if (
      handoff !== settledFocus ||
      currentBusy ||
      currentPending ||
      currentProblem?.outcome === 'closed' ||
      query.isFetching ||
      query.isError ||
      !viewer ||
      viewer.state === 'pending'
    )
      return;
    if ((currentRecovery || currentProblem) && !handoff.control.isConnected) return;
    handoff.cancel();
    const document = handoff.control.ownerDocument;
    if (document.activeElement && document.activeElement !== document.body) return;
    if (handoff.control.isConnected) {
      if (!handoff.control.hasAttribute('disabled')) handoff.control.focus({ preventScroll: true });
    } else if (summary.current?.isConnected) summary.current.focus({ preventScroll: true });
  });

  useEffect(() => {
    const previous = previousCaller.current;
    previousCaller.current = caller;
    const operation = inFlight.current;
    if (
      operation?.caller === previous &&
      operation.kind === 'command' &&
      operation.action === 'leave' &&
      attempt.current?.action === 'leave'
    )
      setLeaveRecovery({ kind: 'uncertain', ownerReason: 'unavailable' });
  }, [caller]);

  useEffect(() => {
    const firstAuthority = initialAuthority.current;
    const isInitialAuthority = firstAuthority.store === caller.store && firstAuthority.revision === caller.revision;
    if (
      viewer?.state === 'pending' &&
      currentProblem?.outcome !== 'closed' &&
      !currentRecovery &&
      !currentPending &&
      isInitialAuthority
    )
      setPending({ cycle: 0, caller });
  }, [viewer?.state, currentProblem, currentRecovery, currentPending, caller]);

  useEffect(() => {
    if (!currentPending) return;
    const controller = new AbortController();
    const cycle = currentPending;
    const current = () => !controller.signal.aborted && cycle.caller.isCurrent();
    setRefresh({ value: 'checking', caller: cycle.caller });
    void refreshRealmMembership(
      async () => {
        if (!current()) throw new Error('Realm membership caller retired');
        const result = await client.fetchQuery(realmMembershipQuery(realm.id, subject, cycle.caller));
        if (!current()) throw new Error('Realm membership caller retired');
        return result;
      },
      cycle.target,
      { signal: controller.signal, guard: current },
    ).then(async (result) => {
      if (!current() || result.kind === 'cancelled') return;
      if (result.kind === 'settled' || result.kind === 'denied') {
        await client.invalidateQueries({ queryKey: ['my-realms'] });
        if (!current()) return;
        if (spaceId) await client.invalidateQueries({ queryKey: ['follow-state', spaceId] });
        if (!current()) return;
        await router.invalidate();
        if (!current()) return;
        setSettledFocus(cycle.focus ?? null);
        setPending(null);
        setRefresh(null);
        setProblem((previous) => (previous?.outcome === 'closed' ? previous : null));
        attempt.current = null;
      } else setRefresh({ value: result.kind, caller: cycle.caller });
    });
    return () => controller.abort();
  }, [currentPending, client, realm.id, subject, router, spaceId]);

  function isLocked() {
    return !!inFlight.current?.caller.isCurrent();
  }

  function startOperation(owner: RealmMembershipCaller, kind: MembershipOperation['kind'], action?: 'join' | 'leave') {
    const focus = startResultFocus(owner);
    const operation: MembershipOperation = { caller: owner, kind, focus, ...(action ? { action } : {}) };
    inFlight.current = operation;
    setBusy({ value: true, caller: owner });
    return operation;
  }

  function finishOperation(operation: MembershipOperation) {
    if (inFlight.current === operation && operation.caller.isCurrent()) {
      inFlight.current = null;
      setBusy({ value: false, caller: operation.caller });
    }
  }

  async function checkJoinAdmission() {
    if (
      !caller.isReady() ||
      currentProblem?.outcome !== 'closed' ||
      currentRecovery ||
      currentPending ||
      isLocked() ||
      query.isFetching
    )
      return;
    const operation = startOperation(caller, 'check');
    const isCurrent = () => operation.caller.isCurrent() && inFlight.current === operation;
    setRefresh({ value: 'checking', caller });
    try {
      // One explicit read checks native membership and participation without submitting a command.
      const result = await query.refetch();
      if (!isCurrent()) return;
      if (result.isError || !result.data || !hasCurrentRealmMembership(client, realm.id, subject, caller)) {
        setRefresh({ value: 'unavailable', caller });
        return;
      }
      await client.invalidateQueries({ queryKey: ['my-realms'] });
      if (!isCurrent()) return;
      if (spaceId) await client.invalidateQueries({ queryKey: ['follow-state', spaceId] });
      if (!isCurrent()) return;
      // Refresh any page-supplied action admission before releasing the closed notice.
      await router.invalidate();
      if (!isCurrent()) return;
      attempt.current = null;
      setProblem(null);
      setRefresh(null);
      setSettledFocus(operation.focus);
      if (result.data.state === 'pending') setPending({ cycle: 0, caller, focus: operation.focus });
    } catch {
      if (isCurrent()) setRefresh({ value: 'unavailable', caller });
    } finally {
      finishOperation(operation);
    }
  }

  async function checkLeave() {
    if (!caller.isCurrent() || !currentRecovery || isLocked() || currentPending) return;
    const operation = startOperation(caller, 'check');
    const isCurrent = () => operation.caller.isCurrent() && inFlight.current === operation;
    setLeaveCheck({ value: 'checking', caller });
    try {
      // This query reads both current membership and native participation admission.
      const result = await query.refetch();
      if (!isCurrent()) return;
      if (result.isError || !result.data || !hasCurrentRealmMembership(client, realm.id, subject, caller))
        setLeaveCheck({ value: 'unavailable', caller });
      else if (realmLeaveReadResolves(currentRecovery, result.data.state)) {
        await client.invalidateQueries({ queryKey: ['my-realms'] });
        if (!isCurrent()) return;
        if (spaceId) await client.invalidateQueries({ queryKey: ['follow-state', spaceId] });
        if (!isCurrent()) return;
        await router.invalidate();
        if (!isCurrent()) return;
        attempt.current = null;
        setSettledFocus(operation.focus);
        setLeaveRecovery(null);
        setLeaveCheck(null);
      } else {
        setLeaveCheck({ value: 'unchanged', caller });
        setSettledFocus(operation.focus);
      }
    } catch {
      if (!isCurrent()) return;
      setLeaveCheck({ value: 'unavailable', caller });
    } finally {
      finishOperation(operation);
    }
  }

  async function change(action: 'join' | 'leave', retryLeave = false) {
    if (
      !caller.isCurrent() ||
      !viewer ||
      !csrfToken ||
      isLocked() ||
      currentPending ||
      query.isFetching ||
      query.isError ||
      query.isPending ||
      (currentRecovery && !(retryLeave && action === 'leave' && currentRecovery.kind === 'uncertain')) ||
      (action === 'join' && realm.visibility === 'protected') ||
      (admittedAction !== undefined && admittedAction !== action)
    )
      return;
    const operation = startOperation(caller, 'command', action);
    const current = () => operation.caller.isCurrent() && inFlight.current === operation;
    setProblem(null);
    setLeaveCheck(null);
    const input =
      attempt.current?.action === action
        ? attempt.current
        : { action, idempotencyKey: viewer.idempotencyKey, csrfToken };
    attempt.current = input;
    try {
      if (!current()) return;
      const result = await changeRealmMembership({
        data: { realmId: realm.id, action: input.action, idempotencyKey: input.idempotencyKey },
        headers: { 'X-CSRF-Token': input.csrfToken },
      });
      if (!current()) return;
      if (result.outcome === 'accepted') {
        setLeaveRecovery(null);
        setRefresh({ value: 'checking', caller });
        setPending({ target: action === 'join' ? 'member' : 'none', cycle: 0, caller, focus: operation.focus });
      } else if (action === 'leave') setLeaveRecovery(classifyRealmLeaveFailure(result));
      else setProblem(result);
    } catch {
      if (!current()) return;
      if (action === 'leave') setLeaveRecovery(classifyRealmLeaveFailure({ outcome: 'refused' }));
      else setProblem({ outcome: 'refused' });
    } finally {
      finishOperation(operation);
    }
  }

  return (
    <div className="contents" onClickCapture={captureActivation} onClick={() => (activation.current = null)}>
      <RealmParticipationView
        summaryRef={summary}
        memberLabel={memberLabel}
        admittedAction={admittedAction}
        state={
          currentPending && !currentProblem
            ? 'pending'
            : currentRecovery && viewer
              ? viewer.state
              : !caller.isReady() || query.isPending || query.isFetching
                ? 'loading'
                : query.isError || !viewer
                  ? 'unavailable'
                  : viewer.state
        }
        visibility={realm.visibility}
        busy={currentBusy}
        ready={!!csrfToken && !currentRecovery && caller.isCurrent()}
        refresh={currentRefresh}
        problem={currentProblem}
        onChange={(action) => void change(action)}
        onRetry={() => {
          if (currentRecovery) void checkLeave();
          else if (currentProblem?.outcome === 'closed') void checkJoinAdmission();
          else {
            const focus = startResultFocus(caller);
            if (currentPending || currentProblem?.outcome === 'refused' || viewer?.state === 'pending')
              setPending({ target: currentPending?.target, cycle: (currentPending?.cycle ?? -1) + 1, caller, focus });
            else void query.refetch().then((result) => {
              if (!result.isError) setSettledFocus(focus);
            });
          }
        }}
      />
      {currentRecovery ? (
        <RealmLeaveRecovery
          key={currentRecovery.kind}
          realmId={realm.id}
          recovery={currentRecovery}
          check={currentLeaveCheck}
          busy={currentBusy}
          ready={!!csrfToken && caller.isCurrent() && !query.isError && !query.isFetching}
          onCheck={() => void checkLeave()}
          onRetry={() => void change('leave', true)}
        />
      ) : null}
    </div>
  );
}
