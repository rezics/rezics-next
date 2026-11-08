import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useSession } from '../../session/query';
import { changeRealmMembership } from '../space-actions';
import { realmMembershipQuery, refreshRealmMembership } from '../realm-membership-queries';
import {
  hasCurrentRealmMembership,
  realmMembershipObservationVersion,
  useRealmMembershipCaller,
  type RealmMembershipCommandAttempt,
  type RealmMembershipCaller,
} from '../realm-membership-lifetime';
import { classifyRealmLeaveFailure } from '../realm-leave-recovery';
import type { MyRealmsPage } from '../space';
import type { MyRealmsViewOwner } from '../my-realms-caller';
import type {
  MyRealmsCurrentController,
  MyRealmsCurrentRow,
  MyRealmsLeaveReviewState,
  MyRealmsStanding,
} from './contract';
import {
  attemptMatchesIntent,
  createMyRealmsLeaveIntent,
  sameLeaveAdmission,
  type MyRealmsFrozenLeaveIntent,
} from './selection';

type ActiveReview = {
  intent: MyRealmsFrozenLeaveIntent;
  attempt: RealmMembershipCommandAttempt;
  heldAttempt: RealmMembershipCommandAttempt;
  phase: MyRealmsLeaveReviewState['phase'];
  standing: MyRealmsStanding;
  workflowId?: string;
  ownerReason?: 'last-owner' | 'unavailable' | undefined;
};

function currentRow(page: MyRealmsPage, intent: MyRealmsFrozenLeaveIntent): MyRealmsCurrentRow | undefined {
  const row = page.realms.find((item) => item.realmId === intent.realmId);
  return row && sameLeaveAdmission(intent, row) ? row : undefined;
}

function reviewState(active: ActiveReview): MyRealmsLeaveReviewState {
  return Object.freeze({
    row: active.intent.row,
    phase: active.phase,
    standing: active.standing,
    ...(active.workflowId ? { workflowId: active.workflowId } : {}),
    ...(active.ownerReason ? { ownerReason: active.ownerReason } : {}),
    retryAllowed: active.phase === 'uncertain',
  });
}

/** Owns one selected leave operation; all writes and standing reads use the existing Realm-membership owners. */
export function MyRealmsCurrentControllerHost({
  page,
  owner,
  children,
}: {
  page: MyRealmsPage;
  owner: MyRealmsViewOwner;
  children(controller: MyRealmsCurrentController): ReactNode;
}) {
  const client = useQueryClient();
  const router = useRouter();
  const session = useSession();
  const visitSubject = owner.visit.session.subject;
  const [active, setActive] = useState<ActiveReview | null>(null);
  const activeRef = useRef<ActiveReview | null>(null);
  const admitted =
    active &&
    active.intent.page === page &&
    active.intent.visitId === owner.visit.id &&
    owner.isCurrent() &&
    owner.acceptsPage(page) &&
    session.state === 'signed-in' &&
    session.subject === active.intent.accountId &&
    session.csrfToken === active.intent.credential &&
    currentRow(page, active.intent)
      ? active
      : null;
  const realmId = admitted?.intent.realmId ?? page.realms[0]?.realmId ?? '__my-realms-no-selection__';
  const subject = visitSubject ?? '__my-realms-no-account__';
  const caller = useRealmMembershipCaller(client, realmId, subject, session.csrfToken);
  const visible = admitted && caller.isCurrent() ? admitted : null;
  useSyncExternalStore(owner.subscribe, owner.getRevision, owner.getRevision);

  const ready =
    owner.ready &&
    owner.isCurrent() &&
    owner.acceptsPage(page) &&
    session.state === 'signed-in' &&
    typeof visitSubject === 'string' &&
    visitSubject.length > 0 &&
    session.subject === visitSubject &&
    !!session.csrfToken &&
    caller.isCurrent();

  const owns = useCallback(
    (candidate: ActiveReview) =>
      activeRef.current === candidate &&
      candidate.intent.page === page &&
      candidate.intent.visitId === owner.visit.id &&
      owner.isCurrent() &&
      owner.acceptsPage(page) &&
      session.state === 'signed-in' &&
      session.subject === candidate.intent.accountId &&
      caller.isCurrent() &&
      caller.realmId === candidate.intent.realmId &&
      caller.subject === candidate.intent.accountId &&
      caller.csrfToken === candidate.intent.credential &&
      !!currentRow(page, candidate.intent),
    [caller, owner, page, session.state, session.subject],
  );

  const publish = useCallback((next: ActiveReview | null) => {
    activeRef.current = next;
    setActive(next);
  }, []);

  useEffect(() => {
    const current = activeRef.current;
    if (
      current &&
      (current.intent.page !== page ||
        current.intent.visitId !== owner.visit.id ||
        !owner.ready ||
        !owner.isCurrent() ||
        !owner.acceptsPage(page) ||
        session.state !== 'signed-in' ||
        session.subject !== current.intent.accountId ||
        session.csrfToken !== current.intent.credential ||
        !caller.isCurrent() ||
        !currentRow(page, current.intent))
    )
      publish(null);
  }, [caller, owner, owner.visit.id, page, publish, session.csrfToken, session.state, session.subject]);

  const readStanding = useCallback(
    async (candidate: ActiveReview, membershipCaller: RealmMembershipCaller) => {
      const isCurrent = () => owns(candidate) && membershipCaller.isCurrent();
      if (!isCurrent()) return;
      let observedStanding: MyRealmsStanding = 'loading';
      const result = await refreshRealmMembership(
        async () => {
          if (!isCurrent()) throw new Error('My Realms leave selection retired');
          const query = realmMembershipQuery(candidate.intent.realmId, candidate.intent.accountId, membershipCaller);
          const viewer = await client.fetchQuery({ ...query, staleTime: 0 });
          if (!isCurrent()) throw new Error('My Realms standing read retired');
          if (!viewer) return null;
          if (
            !hasCurrentRealmMembership(client, candidate.intent.realmId, candidate.intent.accountId, membershipCaller)
          )
            throw new Error('My Realms standing read retired');
          observedStanding = viewer.state;
          return viewer;
        },
        'none',
        { guard: isCurrent },
      );
      if (!isCurrent() || result.kind === 'cancelled') return;
      const standing =
        result.kind === 'settled' || result.kind === 'denied'
          ? result.viewer.state
          : result.kind === 'pending'
            ? observedStanding
            : 'unavailable';
      const next = { ...candidate, standing } as ActiveReview;
      publish(next);
      if (result.kind === 'settled' && result.viewer.state === 'none') {
        void client.invalidateQueries({ queryKey: ['my-realms'] });
        void router.invalidate();
      }
    },
    [client, owns, publish, router],
  );

  const run = useCallback(
    async (candidate: ActiveReview, membershipCaller: RealmMembershipCaller) => {
      if (!ready || !owns(candidate) || !membershipCaller.isReady()) return;
      const submitting = { ...candidate, phase: 'submitting' as const, standing: 'loading' as const };
      publish(submitting);
      const selected = candidate;
      const isCurrent = () => activeRef.current === submitting && owns(submitting) && membershipCaller.isCurrent();
      try {
        const result = await changeRealmMembership({
          data: selected.attempt.body,
          headers: { 'X-CSRF-Token': selected.attempt.credential },
        });
        if (!isCurrent()) return;
        if (result.outcome === 'accepted') {
          membershipCaller.store.acknowledgeNativeCommand(selected.attempt, result.workflowId);
          const pending = {
            ...selected,
            phase: 'pending' as const,
            standing: 'loading' as const,
            workflowId: result.workflowId,
            ownerReason: undefined,
          };
          publish(pending);
          void readStanding(pending, membershipCaller);
          return;
        }
        if (result.outcome === 'closed') {
          publish({ ...selected, phase: 'refused', standing: 'member', ownerReason: 'unavailable' });
          return;
        }
        const recovery = classifyRealmLeaveFailure(result);
        publish({
          ...selected,
          phase: recovery.kind,
          standing: 'member',
          ownerReason: recovery.ownerReason,
        });
      } catch {
        if (isCurrent()) publish({ ...selected, phase: 'uncertain', standing: 'member', ownerReason: 'unavailable' });
      }
    },
    [client, owns, publish, readStanding, ready],
  );

  const select = useCallback(
    (row: MyRealmsCurrentRow) => {
      if (!ready || !session.csrfToken || !visitSubject || !page.realms.includes(row)) return;
      const advice = row.current.actions.leave;
      if (advice.state !== 'available' || row.current.viewer.membership.state !== 'member') return;
      const proposal = createMyRealmsLeaveIntent({
        page,
        visitId: owner.visit.id,
        accountId: visitSubject,
        row,
        advice,
        credential: session.csrfToken,
        key: crypto.randomUUID(),
        observation: realmMembershipObservationVersion(row),
      });
      const held = caller.store.nativeCommand(row.realmId, visitSubject);
      const attempt = caller.store.retainNativeCommand(proposal.attempt);
      const compatible = attemptMatchesIntent(attempt, proposal) && attempt.credential === proposal.credential;
      const exact = Object.freeze({ ...proposal, attempt });
      const acknowledged = compatible && caller.store.nativeCommandAcknowledged(attempt);
      const selected: ActiveReview = {
        intent: exact,
        attempt,
        heldAttempt: held ?? attempt,
        phase: compatible ? (acknowledged ? 'pending' : held ? 'uncertain' : 'review') : 'blocked',
        standing: acknowledged ? 'loading' : 'member',
        ...(caller.store.nativeCommandWorkflowId(attempt)
          ? { workflowId: caller.store.nativeCommandWorkflowId(attempt)! }
          : {}),
        ...(compatible ? {} : { ownerReason: 'unavailable' as const }),
      };
      publish(selected);
      if (acknowledged) void readStanding(selected, caller);
    },
    [caller, owner.visit.id, page, publish, readStanding, ready, session.csrfToken, visitSubject],
  );

  const cancel = useCallback(() => {
    const current = activeRef.current;
    if (current && current.phase === 'review' && owns(current)) {
      caller.store.discardNativeCommand(current.intent.realmId, current.intent.accountId, current.heldAttempt);
      publish(null);
    }
  }, [caller.store, owns, publish]);

  const confirm = useCallback(() => {
    const current = activeRef.current;
    if (current?.phase === 'review') void run(current, caller);
  }, [caller, run]);

  const retry = useCallback(() => {
    const current = activeRef.current;
    if (current?.phase === 'uncertain') void run(current, caller);
  }, [caller, run]);

  const refresh = useCallback(() => {
    const current = activeRef.current;
    if (current?.phase === 'pending' && owns(current)) {
      const checking = { ...current, standing: 'loading' as const };
      publish(checking);
      void readStanding(checking, caller);
    }
  }, [caller, owns, publish, readStanding]);

  const discard = useCallback(() => {
    const current = activeRef.current;
    if (
      !current ||
      !owns(current) ||
      (current.phase !== 'uncertain' && current.phase !== 'refused' && current.phase !== 'blocked')
    )
      return;
    current.intent &&
      caller.store.discardNativeCommand(current.intent.realmId, current.intent.accountId, current.heldAttempt);
    publish(null);
  }, [caller.store, owns, publish]);

  const review = visible && owner.acceptsPage(page) ? reviewState(visible) : null;
  const controller = useMemo<MyRealmsCurrentController>(
    () => ({ ready, review, select, cancel, confirm, retry, refresh, discard }),
    [ready, review, select, cancel, confirm, retry, refresh, discard],
  );
  return <>{children(controller)}</>;
}
