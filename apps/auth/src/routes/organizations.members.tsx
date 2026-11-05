import { createFileRoute, Link, useBlocker, useRouter } from '@tanstack/react-router';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import {
  MembershipRosterNavigation,
  type RosterRequest,
  type RosterDirection,
} from '../organization-membership-roster';
import {
  OrganizationMembershipRoster,
  RosterPageControls,
  rosterDirectionLabel,
} from '../organization-membership-roster-view';
import { OrganizationMembershipReturnView } from '../organization-membership-return-view';
import {
  retainMembershipHistory,
  type MembershipHistory,
  type MembershipHistoryKind,
} from '../organization-membership-return';
import { Alert, AlertDescription } from '@rezics/ui/shadcn/alert';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { AuthButton as Button } from '../button';
import { AuthPage } from '../frame';
import { PasswordInput } from '../password-input';
import { loadAccountSession } from '../account-operations';
import { MembershipRecoveryView } from '../membership-recovery-view';
import {
  isUnresolvedMembership,
  membershipPageAllowsCommand,
  membershipReservationMatches,
  sameMembershipCommand,
} from '../membership-recovery';
import { m } from '../paraglide/messages.js';
import {
  clearMembershipCommandIfMatches,
  loadMembershipPage,
  loadSelectedMembership,
  membershipReadback,
  reauthenticateMembershipSession,
  membershipId,
  membershipProfile,
  membershipSessionMatches,
  newMembershipCommand,
  readMembershipCommand,
  reauthenticateMembership,
  saveMembershipCommand,
  submitMembership,
  type MembershipCommand,
  type MembershipOutcome,
  type MembershipPage,
} from '../organization-membership';

export const Route = createFileRoute('/organizations/members')({
  validateSearch: (search: Record<string, unknown>) => ({
    organizationId: membershipId(search.organizationId) ? search.organizationId : '',
  }),
  head: () => ({ meta: [{ title: `${m.auth_members_heading()} · REZICS` }] }),
  component: MembershipRoute,
});
function MembershipRoute() {
  const { organizationId } = Route.useSearch();
  return <OrganizationMembersPage organizationId={organizationId} />;
}
function statusMessage(kind: string) {
  switch (kind) {
    case 'loading':
      return m.auth_members_loading();
    case 'signed-out':
      return m.auth_account_operation_sign_in_required();
    case 'denied':
      return m.auth_members_denied();
    case 'missing':
      return m.auth_members_missing();
    case 'preparing':
      return m.auth_members_preparing();
    case 'conflict':
      return m.auth_members_conflict();
    case 'unknown':
      return m.auth_members_unknown();
    case 'acknowledged':
      return m.auth_members_acknowledged();
    case 'step-up':
      return m.auth_members_step_up();
    default:
      return m.auth_members_unavailable();
  }
}
function recoveryStatusMessage(kind: string) {
  switch (kind) {
    case 'signed-out':
      return m.auth_account_operation_sign_in_required();
    case 'denied':
      return m.auth_members_denied();
    case 'missing':
      return m.auth_members_missing();
    case 'preparing':
      return m.auth_members_preparing();
    case 'conflict':
      return m.auth_members_conflict();
    case 'unavailable':
      return m.auth_members_recovery_unavailable();
    default:
      return m.auth_members_recovery_review();
  }
}
export function OrganizationMembersPage({ organizationId }: { organizationId: string }) {
  return <MembershipReview key={organizationId} organizationId={organizationId} />;
}
export { OrganizationMembershipRoster } from '../organization-membership-roster-view';
// Keep the router adapter local; the review can also be mounted without a router.
function MembershipNavigation({ choose }: { choose: () => Promise<boolean> }) {
  useBlocker({ shouldBlockFn: async () => !(await choose()), enableBeforeUnload: false });
  return null;
}
function DepartureChoice({ answer, focusFallback }: { answer: (leave: boolean) => void; focusFallback: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const stay = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    stay.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
      else focusFallback();
    };
  }, [focusFallback]);
  return (
    <dialog
      ref={dialog}
      aria-labelledby="membership-departure"
      onCancel={(event) => {
        event.preventDefault();
        answer(false);
      }}
      className="rounded-md border bg-background p-6 text-foreground"
    >
      <h2 id="membership-departure">{m.auth_members_departure()}</h2>
      <p>{m.auth_account_operation_leave_notice()}</p>
      <div className="mt-4 flex gap-2">
        <Button ref={stay} type="button" onClick={() => answer(false)}>
          {m.auth_members_stay()}
        </Button>
        <Button type="button" variant="outline" onClick={() => answer(true)}>
          {m.auth_members_leave()}
        </Button>
      </div>
    </dialog>
  );
}
function MembershipReview({ organizationId }: { organizationId: string }) {
  const router = useRouter({ warn: false });
  const [history, setHistory] = useState<MembershipHistory>([]);
  const phase = useRef<MembershipHistoryKind | null>(null);
  function remember(kind: MembershipHistoryKind) {
    setHistory((previous) => retainMembershipHistory(previous, kind));
  }
  const [page, setPage] = useState<MembershipPage | null>(null);
  const [accountId, setAccountId] = useState('');
  const [command, setCommand] = useState<MembershipCommand | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [needsProfile, setNeedsProfile] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [reauth, setReauth] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [observed, setObserved] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [departing, setDeparting] = useState(false);
  const [revoked, setRevoked] = useState(false);
  const [reviewCurrent, setReviewCurrent] = useState(false);
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const [recoveryStatus, setRecoveryStatus] = useState('review');
  const roster = useRef(new MembershipRosterNavigation());
  const lifetime = useRef(0);
  const pageRead = useRef(new AbortController());
  const pendingDeparture = useRef<{ promise: Promise<boolean>; resolve: (leave: boolean) => void } | null>(null);
  const work = useRef(false);
  const lock = useRef(false);
  const activity = useRef<() => boolean>(() => false);
  const feedback = useRef<HTMLDivElement>(null);
  const confirmation = useRef<HTMLHeadingElement>(null);
  const recoveryHeading = useRef<HTMLHeadingElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);

  // Invalidate before another page can handle input. Each continuation captures
  // this particular lifetime, including across Strict Mode effect replay.
  useLayoutEffect(() => {
    renewActivity();
    return () => {
      lifetime.current++;
      pageRead.current.abort();
      roster.current.clear();
      lock.current = false;
      pendingDeparture.current?.resolve(false);
    };
  }, []);
  useEffect(() => {
    void Promise.resolve().then(() => reload());
  }, []);
  useLayoutEffect(() => {
    if (notice) feedback.current?.focus();
  }, [notice]);
  useLayoutEffect(() => {
    if (command && reviewCurrent && !revoked) confirmation.current?.focus();
  }, [command?.operationKey, reviewCurrent, revoked]);
  const acknowledged = phase.current === 'acknowledged';
  const unresolved = isUnresolvedMembership(command, observed) && !acknowledged;
  const recoveryVisible = recoveryBlocked || (unresolved && (!reviewCurrent || revoked));
  useLayoutEffect(() => {
    if (recoveryVisible && !departing) recoveryHeading.current?.focus();
  }, [recoveryVisible, departing, recoveryStatus]);
  useLayoutEffect(() => {
    if (reauth && recoveryVisible) emailInput.current?.focus();
  }, [reauth, recoveryVisible]);
  useLayoutEffect(() => {
    if (revoked && !recoveryVisible && !history.length) document.getElementById('membership-current-heading')?.focus();
  }, [revoked, recoveryVisible, history.length]);
  const focusRecovery = useCallback(() => {
    (
      recoveryHeading.current ??
      document.getElementById('membership-history-heading') ??
      document.getElementById('membership-current-heading')
    )?.focus();
  }, []);

  work.current = isUnresolvedMembership(command, observed) || (!revoked && !observed && (!!command || selecting));
  function renewActivity() {
    pageRead.current.abort();
    pageRead.current = new AbortController();
    const version = ++lifetime.current;
    activity.current = () => version === lifetime.current;
    lock.current = false;
  }
  function retirePrivateAuthority(kind = 'review', keepNavigation = false) {
    const acknowledged = phase.current === 'acknowledged';
    const wasUnresolved = isUnresolvedMembership(command, observed);
    const classification = acknowledged
      ? 'acknowledged'
      : command?.unresolved && !observed
        ? 'unresolved'
        : phase.current === 'refused'
          ? 'refused'
          : command || selecting || reauth
            ? 'unsent'
            : phase.current;
    // Close every old continuation before synchronously removing private DOM.
    lifetime.current++;
    pageRead.current.abort();
    if (!keepNavigation) roster.current.clear();
    activity.current = () => false;
    lock.current = false;
    let blocked = recoveryBlocked;
    if (command) {
      const saved = readMembershipCommand();
      if (wasUnresolved) blocked = !sameMembershipCommand(saved, command);
      else blocked = !clearMembershipCommandIfMatches(command);
    }
    flushSync(() => {
      if (classification) remember(classification);
      setAccountId('');
      setRecoveryBlocked(blocked);
      setRecoveryStatus(blocked ? 'unavailable' : wasUnresolved ? kind : 'review');
      setConfirmed(false);
      setEmail('');
      setPassword('');
      setReauth(false);
      setNotice(wasUnresolved && !acknowledged ? 'unknown' : '');
      setBusy(false);
      setSelecting(false);
      setReviewCurrent(false);
      setRevoked(true);
      setPage(null);
      if (!wasUnresolved) {
        setCommand(null);
        setObserved(false);
      }
      work.current = wasUnresolved;
    });
  }
  function installPage(result: MembershipPage) {
    if (result.kind !== 'ready') {
      const wasUnresolved = isUnresolvedMembership(command, observed);
      retirePrivateAuthority(result.kind);
      setPage(result);
      if (!wasUnresolved) {
        pendingDeparture.current?.resolve(true);
        pendingDeparture.current = null;
        setDeparting(false);
      }
      return;
    }
    setPage(result);
    if (!recoveryBlocked) setRevoked(false);
  }
  const choose = useCallback((): Promise<boolean> => {
    if (!work.current) return Promise.resolve(true);
    if (pendingDeparture.current) return pendingDeparture.current.promise;
    let resolve!: (leave: boolean) => void;
    const promise = new Promise<boolean>((done) => {
      resolve = done;
    });
    pendingDeparture.current = { promise, resolve };
    setDeparting(true);
    return promise;
  }, []);
  function answer(leave: boolean) {
    if (leave) retirePrivateAuthority('review', true);
    pendingDeparture.current?.resolve(leave);
    pendingDeparture.current = null;
    setDeparting(false);
  }
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (work.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    const hide = () => retirePrivateAuthority();
    const show = (event: PageTransitionEvent) => {
      if (event.persisted) {
        renewActivity();
        void reload();
      }
    };
    window.addEventListener('beforeunload', unload);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    return () => {
      window.removeEventListener('beforeunload', unload);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
    };
  });
  async function browse(direction: RosterDirection = 'reload', cursor?: string) {
    if (lock.current) return;
    // Lock before the departure promise yields, including a clean-page choice.
    lock.current = true;
    const version = lifetime.current;
    const leavingReview = work.current;
    const allowed = await choose();
    // Leave retires the review once. A separate private retirement cancels navigation.
    if (!allowed || lifetime.current !== version + (leavingReview ? 1 : 0)) {
      if (lifetime.current === version) lock.current = false;
      return;
    }
    const request = roster.current.request(direction, cursor);
    renewActivity();
    if (isUnresolvedMembership(command, observed) && phase.current !== 'acknowledged') await reviewRecovery(request);
    else await reload(request);
  }
  function refreshCurrent() {
    if (lock.current) return;
    renewActivity();
    void reload(roster.current.request('retry'));
  }
  function acceptRead(result: MembershipPage, request: RosterRequest) {
    if (result.kind === 'ready') {
      roster.current.accept(request);
      installPage(result);
    } else if (result.kind === 'unavailable' || result.kind === 'preparing' || result.kind === 'conflict') {
      // The requested target remains exact; only an accepted page moves history.
      setPage(result);
      setConfirmed(false);
      setReviewCurrent(false);
    } else installPage(result);
  }
  function refreshRecovery() {
    if (lock.current) return;
    renewActivity();
    void reviewRecovery(roster.current.request('retry'));
  }
  function retainUnknown(command: MembershipCommand, kind: string, result?: MembershipPage) {
    remember('unresolved');
    phase.current = 'unresolved';
    const exact = sameMembershipCommand(readMembershipCommand(), command);
    setCommand(command);
    setObserved(false);
    setConfirmed(false);
    setEmail('');
    setPassword('');
    setReauth(false);
    setNeedsProfile(true);
    setReviewCurrent(false);
    const retryable = exact && !!command.reference;
    setRecoveryBlocked(!retryable);
    setRecoveryStatus(retryable ? kind : 'unavailable');
    setNotice('unknown');
    setRevoked(true);
    setPage(result ?? null);
    work.current = true;
  }
  async function reload(request = roster.current.request('retry')) {
    const isActive = activity.current;
    const readSignal = pageRead.current.signal;
    if (!isActive() || lock.current) return;
    lock.current = true;
    setBusy(true);
    setPage(null);
    try {
      if (!membershipId(organizationId)) {
        installPage({ kind: 'missing' });
        return;
      }
      const saved = readMembershipCommand();
      const discardedUnsent = !!command && !command.unresolved && saved === null;
      const knownAcknowledgement =
        phase.current === 'acknowledged' && !!command && sameMembershipCommand(saved, command);
      if (
        saved === 'invalid' ||
        (saved && saved.operation.organizationId !== organizationId) ||
        (command && !sameMembershipCommand(saved, command) && !discardedUnsent)
      ) {
        setRecoveryBlocked(true);
        setRecoveryStatus('unavailable');
        setRevoked(true);
        setReviewCurrent(false);
        if (isUnresolvedMembership(command, observed)) setNotice('unknown');
        setPage({ kind: 'unavailable' });
        return;
      }
      if (saved?.unresolved && !knownAcknowledgement) {
        retainUnknown(saved, 'review');
      }
      const session = await loadAccountSession(readSignal);
      if (!isActive()) return;
      const latest = readMembershipCommand();
      const unchanged = saved === null ? latest === null : sameMembershipCommand(latest, saved);
      if (latest === 'invalid' || !unchanged) {
        setRecoveryBlocked(true);
        setRecoveryStatus('unavailable');
        setRevoked(true);
        setReviewCurrent(false);
        if (isUnresolvedMembership(command, observed) || saved?.unresolved) setNotice('unknown');
        setPage({ kind: 'unavailable' });
        return;
      }
      if (session.kind !== 'ready') {
        if (saved?.unresolved && !knownAcknowledgement) {
          retainUnknown(saved, session.kind, { kind: session.kind === 'signed-out' ? 'signed-out' : 'unavailable' });
          return;
        }
        acceptRead({ kind: session.kind === 'signed-out' ? 'signed-out' : 'unavailable' }, request);
        return;
      }
      const initiatingAccount = saved?.accountId ?? (accountId || session.accountId);
      if (session.accountId !== initiatingAccount) {
        if (saved?.unresolved && !knownAcknowledgement) {
          retainUnknown(saved, 'denied', { kind: 'unavailable' });
          return;
        }
        installPage({ kind: 'denied' });
        return;
      }
      setAccountId(initiatingAccount);
      const matchingProfile = membershipSessionMatches(session, initiatingAccount);
      setNeedsProfile(!matchingProfile);
      if (saved?.unresolved && !knownAcknowledgement) {
        retainUnknown(saved, matchingProfile ? 'review' : 'signed-out');
        return;
      }
      if (saved && !knownAcknowledgement) {
        setCommand(saved);
        setReviewCurrent(true);
        setNotice('step-up');
      }
      const result = await loadMembershipPage(organizationId, initiatingAccount, request.cursor, readSignal);
      if (!isActive()) return;
      if (knownAcknowledgement && saved && result.kind === 'ready') {
        // A known native acknowledgement permits a separate current observation,
        // never an inference that an unknown request caused matching state.
        const current = await loadSelectedMembership(organizationId, saved.operation.memberAccountId);
        if (!isActive()) return;
        if (!sameMembershipCommand(readMembershipCommand(), saved)) {
          retirePrivateAuthority('unavailable');
          setRecoveryBlocked(true);
          return;
        }
        if (current.kind !== 'ready') {
          installPage(current);
          return;
        }
        const matches = membershipReadback(saved, current);
        setObserved(matches);
        setReviewCurrent(matches);
      }
      acceptRead(result, request);
    } finally {
      if (isActive()) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  async function reviewRecovery(request = roster.current.request('retry')) {
    const isActive = activity.current;
    const readSignal = pageRead.current.signal;
    const expected = command;
    if (!isActive() || lock.current || !expected || !isUnresolvedMembership(expected, observed)) return;
    if (!expected.reference) {
      setRecoveryBlocked(true);
      setRecoveryStatus('unavailable');
      setRevoked(true);
      setReviewCurrent(false);
      return;
    }
    lock.current = true;
    setBusy(true);
    setRevoked(true);
    setReviewCurrent(false);
    setConfirmed(false);
    setReauth(false);
    setEmail('');
    setPassword('');
    setNotice('unknown');
    setRecoveryStatus('review');
    setPage(null);
    try {
      if (!sameMembershipCommand(readMembershipCommand(), expected)) {
        setRecoveryBlocked(true);
        setRecoveryStatus('unavailable');
        return;
      }
      setRecoveryBlocked(false);
      const session = await loadAccountSession(readSignal);
      if (!isActive()) return;
      if (!membershipSessionMatches(session, expected.accountId)) {
        const kind = session.kind === 'signed-out' ? 'signed-out' : session.kind === 'ready' ? 'denied' : 'unavailable';
        installPage({ kind });
        return;
      }
      const currentPage = await loadMembershipPage(organizationId, expected.accountId, request.cursor, readSignal);
      if (!isActive()) return;
      if (currentPage.kind !== 'ready') {
        acceptRead(currentPage, request);
        return;
      }
      if (!membershipPageAllowsCommand(currentPage, expected)) {
        retirePrivateAuthority('denied');
        setPage({ kind: 'denied' });
        return;
      }
      const currentMember = await loadSelectedMembership(organizationId, expected.operation.memberAccountId);
      if (!isActive()) return;
      if (currentMember.kind !== 'ready') {
        installPage(currentMember);
        return;
      }
      if (!membershipReservationMatches(expected, currentMember)) {
        retirePrivateAuthority('conflict');
        setPage({ kind: 'conflict' });
        return;
      }
      if (!sameMembershipCommand(readMembershipCommand(), expected)) {
        setRecoveryBlocked(true);
        setRecoveryStatus('unavailable');
        return;
      }
      roster.current.accept(request);
      setPage(currentPage);
      setRevoked(false);
      setRecoveryBlocked(false);
      setRecoveryStatus('review');
      setReviewCurrent(true);
      setAccountId(expected.accountId);
      setNeedsProfile(false);
      setConfirmed(false);
    } finally {
      if (isActive()) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  function beginRecoverySignIn() {
    if (!command || !unresolved || recoveryBlocked || !membershipProfile()) return;
    setReauth(true);
    setRecoveryStatus('signed-out');
  }
  async function select(memberAccountId: string, desired: 'owner' | 'member' | null) {
    const isActive = activity.current;
    const readSignal = pageRead.current.signal;
    if (!isActive() || lock.current || command || !membershipId(memberAccountId) || !accountId) return;
    if (page?.kind !== 'ready') return;
    if (desired === null) {
      if (page.viewer.role === 'member') {
        if (page.viewer.accountId !== memberAccountId || page.viewer.leave !== 'allowed') return;
      } else {
        const holder =
          page.members.state === 'ready'
            ? page.members.holders.find((row) => row.accountId === memberAccountId)
            : undefined;
        if (!holder || holder.actions.remove !== 'allowed') return;
      }
    } else {
      const holder =
        page.members.state === 'ready'
          ? page.members.holders.find((row) => row.accountId === memberAccountId)
          : undefined;
      if (page.viewer.role !== 'owner' || !holder || holder.actions.changeRole !== 'allowed') return;
    }
    if (needsProfile) {
      setReauth(true);
      setNotice('step-up');
      return;
    }
    lock.current = true;
    setBusy(true);
    setSelecting(true);
    try {
      const current = await loadSelectedMembership(organizationId, memberAccountId);
      if (!isActive()) return;
      if (current.kind !== 'ready') {
        if (current.kind === 'denied' || current.kind === 'signed-out') installPage(current);
        else setNotice(current.kind);
        return;
      }
      if (!current.membership || current.membership.role === desired) {
        setNotice('conflict');
        const resultPage = await loadMembershipPage(organizationId, accountId, roster.current.state.cursor, readSignal);
        if (isActive()) installPage(resultPage);
        return;
      }
      const next = newMembershipCommand(accountId, {
        kind: 'membership',
        organizationId,
        memberAccountId,
        role: desired,
        ...(current.membership ? { reservationId: current.membership.reservationId } : {}),
      });
      if (!saveMembershipCommand(next)) {
        setNotice('unavailable');
        return;
      }
      phase.current = 'unsent';
      setCommand(next);
      setConfirmed(false);
      setNotice('');
      setObserved(false);
      setReviewCurrent(true);
      setRecoveryBlocked(false);
    } finally {
      if (isActive()) {
        lock.current = false;
        setBusy(false);
        setSelecting(false);
      }
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const isActive = activity.current;
    const readSignal = pageRead.current.signal;
    if (!isActive() || lock.current || !command || !confirmed) return;
    if (command.unresolved && (!reviewCurrent || revoked || !sameMembershipCommand(readMembershipCommand(), command))) {
      setRecoveryBlocked(true);
      setRecoveryStatus('unavailable');
      setRevoked(true);
      setReviewCurrent(false);
      setNotice('unknown');
      return;
    }
    lock.current = true;
    setBusy(true);
    setNotice('');
    try {
      if (!membershipProfile()) {
        setNotice('unavailable');
        return;
      }
      if (needsProfile) {
        setReauth(true);
        setNotice('step-up');
        setConfirmed(false);
        return;
      }
      const result: MembershipOutcome = await submitMembership(command, isActive);
      if (!isActive()) return;
      // Record the actual native result before any current-state observation.
      // A later acknowledgement cannot erase an earlier unknown send.
      if (result === 'acknowledged') {
        phase.current = 'acknowledged';
        remember('acknowledged');
      } else if (command.unresolved) {
        phase.current = 'unresolved';
        remember('unresolved');
      } else if (result === 'denied' || result === 'conflict') {
        phase.current = 'refused';
        remember('refused');
      }
      if (result === 'denied') {
        installPage({ kind: 'denied' });
        return;
      }
      setNotice(result);
      setConfirmed(false);
      if (result === 'step-up') setReauth(true);
      const current = await loadSelectedMembership(organizationId, command.operation.memberAccountId);
      if (!isActive()) return;
      if (current.kind !== 'ready') {
        installPage(current);
        return;
      }
      const observedResult = result === 'acknowledged' && membershipReadback(command, current);
      setObserved(observedResult);
      if (!observedResult && !membershipReservationMatches(command, current)) {
        retirePrivateAuthority('conflict');
        setPage({ kind: 'conflict' });
        return;
      }
      const resultPage = await loadMembershipPage(organizationId, accountId, roster.current.state.cursor, readSignal);
      if (isActive()) {
        if (!observedResult && !membershipPageAllowsCommand(resultPage, command)) {
          retirePrivateAuthority('denied');
          setPage({ kind: resultPage.kind === 'ready' ? 'denied' : resultPage.kind });
        } else {
          setReviewCurrent(!observedResult);
          installPage(resultPage);
        }
      }
    } finally {
      if (isActive()) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  async function authenticate(event: FormEvent) {
    event.preventDefault();
    const isActive = activity.current;
    const readSignal = pageRead.current.signal;
    if (!isActive() || lock.current || !accountId || !email || !password) return;
    lock.current = true;
    setBusy(true);
    try {
      const authenticated = await (command
        ? reauthenticateMembership(command, email, password, isActive)
        : reauthenticateMembershipSession(accountId, email, password, isActive));
      if (!isActive()) return;
      if (!authenticated) {
        if (command && isUnresolvedMembership(command, observed)) {
          setRecoveryStatus('unavailable');
          setNotice('unknown');
          setRevoked(true);
          setReviewCurrent(false);
        } else {
          // A refused credential is not session loss. Observe the original
          // actor/profile before retaining its unsent private review.
          const session = await loadAccountSession(readSignal);
          if (!isActive()) return;
          if (!membershipSessionMatches(session, accountId)) {
            installPage({
              kind: session.kind === 'signed-out' ? 'signed-out' : session.kind === 'ready' ? 'denied' : 'unavailable',
            });
          } else setNotice('unavailable');
        }
        return;
      }
      setReauth(false);
      setEmail('');
      setNeedsProfile(false);
      setConfirmed(false);
      if (command && isUnresolvedMembership(command, observed)) {
        setNotice('unknown');
        setRecoveryStatus('review');
        setRevoked(true);
        setReviewCurrent(false);
        setPage(null);
      } else {
        setNotice('step-up');
        setPage(null);
        const result = await loadMembershipPage(organizationId, accountId, roster.current.state.cursor, readSignal);
        if (isActive()) {
          if (command && result.kind === 'ready' && !membershipPageAllowsCommand(result, command)) {
            installPage({ kind: 'denied' });
          } else installPage(result);
        }
      }
    } finally {
      if (isActive()) {
        setPassword('');
        lock.current = false;
        setBusy(false);
      }
    }
  }
  function dismiss() {
    if (busy || !command || (command.unresolved && !observed)) return;
    if (!clearMembershipCommandIfMatches(command)) {
      setRecoveryBlocked(true);
      setRecoveryStatus('unavailable');
      setRevoked(true);
      setReviewCurrent(false);
      return;
    }
    if (!observed && phase.current === 'unsent') remember('unsent');
    phase.current = null;
    setCommand(null);
    setNotice('');
    setReauth(false);
    setConfirmed(false);
    setObserved(false);
    setReviewCurrent(false);
  }
  const effect =
    command?.operation.role === null
      ? m.auth_members_remove_effect()
      : command?.operation.role === 'owner'
        ? m.auth_members_owner_effect()
        : m.auth_members_member_effect();
  const rosterActivity = activity.current;
  return (
    <AuthPage heading={m.auth_members_heading()}>
      {router ? (
        <Link to="/security" className="inline-flex min-h-11 items-center underline underline-offset-4">
          {m.auth_members_back()}
        </Link>
      ) : (
        <a href="/security" className="inline-flex min-h-11 items-center underline underline-offset-4">
          {m.auth_members_back()}
        </a>
      )}
      {router ? <MembershipNavigation choose={choose} /> : null}
      {departing ? <DepartureChoice answer={answer} focusFallback={focusRecovery} /> : null}
      <p>{m.auth_members_intro()}</p>
      <OrganizationMembershipReturnView
        history={history}
        retired={revoked}
        dismiss={() => {
          setHistory([]);
          document.getElementById('membership-current-heading')?.focus();
        }}
      />
      <div aria-busy={busy} className="space-y-5">
        <h2 id="membership-current-heading" tabIndex={-1}>
          {m.auth_members_current_heading()}
        </h2>
        {!recoveryVisible &&
        revoked &&
        !busy &&
        (!page || page.kind === 'signed-out' || page.kind === 'denied' || page.kind === 'missing') ? (
          <Button type="button" variant="outline" onClick={refreshCurrent}>
            {m.auth_members_recovery_retry()}
          </Button>
        ) : null}
        {busy && roster.current.state.requested ? (
          <p role="status">
            {m.auth_members_navigation_pending({
              action: rosterDirectionLabel(roster.current.state.requested.direction),
            })}
          </p>
        ) : null}
        {notice && !recoveryVisible ? (
          <div ref={feedback} tabIndex={-1} role="status">
            <Alert>
              <AlertDescription>{statusMessage(notice)}</AlertDescription>
            </Alert>
          </div>
        ) : null}
        {recoveryVisible ? (
          <MembershipRecoveryView
            status={recoveryStatusMessage(recoveryStatus)}
            outcome={unresolved ? m.auth_members_unknown() : m.auth_members_recovery_unavailable()}
            pending={busy}
            canRetry={!!command && unresolved && !!command.reference && !recoveryBlocked}
            canSignIn={
              !reauth && !!command && unresolved && !!command.reference && !recoveryBlocked && !!membershipProfile()
            }
            retry={refreshRecovery}
            signIn={beginRecoverySignIn}
            headingRef={recoveryHeading}
          />
        ) : page?.kind !== 'ready' ? (
          <div className="space-y-3" role="status">
            <p>{statusMessage(page?.kind ?? (revoked && !busy ? 'unavailable' : 'loading'))}</p>
            {page && page.kind !== 'signed-out' && page.kind !== 'denied' && page.kind !== 'missing' ? (
              <RosterPageControls
                navigation={roster.current.state}
                busy={busy}
                failed
                onNavigate={(direction) => {
                  if (rosterActivity()) {
                    if (revoked && direction === 'retry') refreshCurrent();
                    else void browse(direction);
                  }
                }}
              />
            ) : null}
          </div>
        ) : (
          <OrganizationMembershipRoster
            key={roster.current.state.observation}
            page={page}
            navigation={roster.current.state}
            onNavigate={(direction, cursor) => {
              if (rosterActivity()) void browse(direction, cursor);
            }}
            focusHeading={roster.current.state.observation > 1}
            busy={busy}
            pending={!!command}
            onSelect={(target, role) => {
              if (rosterActivity()) void select(target, role);
            }}
            onReload={(cursor) => {
              if (rosterActivity()) void browse(cursor === undefined ? 'reload' : 'next', cursor);
            }}
          />
        )}

        {reauth ? (
          <form onSubmit={(event) => void authenticate(event)} className="space-y-4">
            <Field>
              <FieldLabel htmlFor="membership-email">{m.auth_login_email()}</FieldLabel>
              <Input
                ref={emailInput}
                id="membership-email"
                type="email"
                autoComplete="username"
                required
                value={email}
                disabled={busy}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="membership-password">{m.auth_login_password()}</FieldLabel>
              <PasswordInput
                id="membership-password"
                autoComplete="current-password"
                required
                value={password}
                disabled={busy}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
            <Button type="submit" disabled={busy} aria-busy={busy}>
              {m.auth_members_reauthenticate()}
            </Button>
            {recoveryVisible ? (
              <Button type="button" variant="outline" disabled={busy} onClick={() => setReauth(false)}>
                {m.auth_inventory_cancel()}
              </Button>
            ) : null}
          </form>
        ) : null}
        {command && (reviewCurrent || observed) && !revoked && !recoveryVisible ? (
          <section className="space-y-4" aria-labelledby="membership-confirmation">
            <h2 id="membership-confirmation" ref={confirmation} tabIndex={-1}>
              {m.auth_members_confirm_heading()}
            </h2>
            <p className="break-all">
              {m.auth_members_confirmation({
                organization: command.operation.organizationId,
                member: command.operation.memberAccountId,
                effect,
              })}
            </p>
            <p className="break-all">{m.auth_members_initiator({ account: command.accountId })}</p>
            {command.operation.reservationId ? (
              <p className="break-all">
                {m.auth_members_reservation({ reservation: command.operation.reservationId })}
              </p>
            ) : null}
            <p>{m.auth_members_authority()}</p>
            {!reauth ? (
              <form onSubmit={(event) => void submit(event)} className="space-y-4">
                <label className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={busy || observed || acknowledged}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  {m.auth_members_confirm_check()}
                </label>
                <Button type="submit" aria-busy={busy} disabled={busy || !confirmed || observed || acknowledged}>
                  {command.unresolved ? m.auth_members_retry_exact() : m.auth_members_submit()}
                </Button>
              </form>
            ) : null}
            <Button
              type="button"
              variant="outline"
              disabled={busy || (command.unresolved && !observed)}
              onClick={dismiss}
            >
              {observed || acknowledged ? m.auth_members_close() : m.auth_inventory_cancel()}
            </Button>
          </section>
        ) : null}
      </div>
    </AuthPage>
  );
}
