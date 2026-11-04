import { createFileRoute, Link, useBlocker, useRouter } from '@tanstack/react-router';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
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
type ReadyMembershipPage = Extract<MembershipPage, { kind: 'ready' }>;
export function OrganizationMembershipRoster({
  page,
  busy,
  pending,
  onSelect,
  onReload,
}: {
  page: ReadyMembershipPage;
  busy: boolean;
  pending: boolean;
  onSelect: (accountId: string, role: 'owner' | 'member' | null) => void;
  onReload: (cursor?: string) => void;
}) {
  const members = page.members;
  return (
    <section aria-labelledby="organization-members-heading" className="space-y-5">
      <div>
        <h2 id="organization-members-heading" className="text-lg font-semibold">
          {m.auth_members_holders()}
        </h2>
        <p>{page.viewer.role === 'owner' ? m.auth_members_owner() : m.auth_members_member()}</p>
      </div>
      {page.viewer.role === 'member' ? (
        page.viewer.leave === 'allowed' ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy || pending}
            onClick={() => onSelect(page.viewer.accountId, null)}
          >
            {m.auth_members_leave_organization()}
          </Button>
        ) : (
          <p role="status">{m.auth_members_leave_unavailable()}</p>
        )
      ) : null}
      {members.state === 'unavailable' ? (
        <div className="space-y-3">
          <p role="status">{m.auth_members_inventory_unavailable()}</p>
          <Button type="button" variant="outline" disabled={busy} onClick={() => onReload()}>
            {m.auth_inventory_reload()}
          </Button>
        </div>
      ) : (
        <>
          <ul className="divide-y" aria-label={m.auth_members_holders()}>
            {members.holders.map((holder) => {
              const displayName = holder.account?.displayName?.trim();
              const handle = holder.account?.handle?.trim();
              const change = holder.actions.changeRole;
              const remove = holder.actions.remove;
              return (
                <li key={holder.accountId} className="space-y-2 py-4">
                  <div>
                    <p className="font-medium">
                      {displayName || (handle ? `@${handle}` : m.auth_members_identity_unavailable())}
                    </p>
                    {displayName && handle ? <p className="text-sm text-muted-foreground">@{handle}</p> : null}
                    <p>{holder.role === 'owner' ? m.auth_members_owner() : m.auth_members_member()}</p>
                    <details className="mt-1 text-sm">
                      <summary className="cursor-pointer">{m.auth_members_account_address()}</summary>
                      <code className="break-all">{holder.accountId}</code>
                    </details>
                  </div>
                  {page.viewer.role === 'owner' ? (
                    <div className="space-y-2">
                      <div className="flex flex-wrap gap-2">
                        {change === 'allowed' ? (
                          <Button
                            type="button"
                            variant="outline"
                            disabled={busy || pending}
                            onClick={() => onSelect(holder.accountId, holder.role === 'owner' ? 'member' : 'owner')}
                          >
                            {m.auth_members_change_role()}
                          </Button>
                        ) : change === 'last-owner' ? (
                          <Button
                            type="button"
                            variant="outline"
                            disabled
                            aria-describedby={`member-last-owner-${holder.accountId}`}
                          >
                            {m.auth_members_change_role()}
                          </Button>
                        ) : (
                          <Button type="button" variant="outline" disabled title={m.auth_members_actions_unavailable()}>
                            {m.auth_members_change_role()}
                          </Button>
                        )}
                        {remove === 'allowed' ? (
                          <Button
                            type="button"
                            variant="outline"
                            disabled={busy || pending}
                            onClick={() => onSelect(holder.accountId, null)}
                          >
                            {m.auth_members_remove()}
                          </Button>
                        ) : remove === 'last-owner' ? (
                          <Button
                            type="button"
                            variant="outline"
                            disabled
                            aria-describedby={`member-last-owner-${holder.accountId}`}
                          >
                            {m.auth_members_remove()}
                          </Button>
                        ) : (
                          <Button type="button" variant="outline" disabled title={m.auth_members_actions_unavailable()}>
                            {m.auth_members_remove()}
                          </Button>
                        )}
                      </div>
                      {change === 'last-owner' || remove === 'last-owner' ? (
                        <p id={`member-last-owner-${holder.accountId}`} role="status">
                          {m.auth_members_last_owner()}
                        </p>
                      ) : null}
                      {change === 'unavailable' || remove === 'unavailable' ? (
                        <p role="status">{m.auth_members_actions_unavailable()}</p>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {!members.holders.length ? <p>{m.auth_members_empty_page()}</p> : null}
          <nav className="flex flex-wrap gap-2" aria-label={m.auth_members_holders()}>
            <Button type="button" variant="outline" disabled={busy} onClick={() => onReload()}>
              {m.auth_inventory_reload()}
            </Button>
            {members.next ? (
              <Button type="button" variant="outline" disabled={busy} onClick={() => onReload(members.next!)}>
                {m.auth_inventory_next()}
              </Button>
            ) : null}
          </nav>
        </>
      )}
    </section>
  );
}
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
  const lifetime = useRef(0);
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
      lock.current = false;
      pendingDeparture.current?.resolve(false);
    };
  }, []);
  useEffect(() => {
    void reload();
  }, []);
  useLayoutEffect(() => {
    if (notice) feedback.current?.focus();
  }, [notice]);
  useLayoutEffect(() => {
    if (command && reviewCurrent && !revoked) confirmation.current?.focus();
  }, [command?.operationKey, reviewCurrent, revoked]);
  const unresolved = isUnresolvedMembership(command, observed);
  const recoveryVisible = recoveryBlocked || (unresolved && (!reviewCurrent || revoked));
  useLayoutEffect(() => {
    if (recoveryVisible && !departing) recoveryHeading.current?.focus();
  }, [recoveryVisible, departing, recoveryStatus]);
  useLayoutEffect(() => {
    if (reauth && recoveryVisible) emailInput.current?.focus();
  }, [reauth, recoveryVisible]);
  const focusRecovery = useCallback(() => recoveryHeading.current?.focus(), []);

  work.current = unresolved || (!revoked && !observed && (!!command || selecting));
  function renewActivity() {
    const version = ++lifetime.current;
    activity.current = () => version === lifetime.current;
    lock.current = false;
  }
  function retirePrivateAuthority(kind = 'review') {
    const wasUnresolved = isUnresolvedMembership(command, observed);
    let blocked = recoveryBlocked;
    renewActivity();
    if (command) {
      const saved = readMembershipCommand();
      if (wasUnresolved) blocked = !sameMembershipCommand(saved, command);
      else blocked = !clearMembershipCommandIfMatches(command);
    }
    setRecoveryBlocked(blocked);
    setRecoveryStatus(blocked ? 'unavailable' : wasUnresolved ? kind : 'review');
    setConfirmed(false);
    setEmail('');
    setPassword('');
    setReauth(false);
    setNotice(wasUnresolved ? 'unknown' : '');
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
    if (leave) retirePrivateAuthority();
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
      if (event.persisted) void reload();
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
  async function browse(cursor?: string) {
    if (await choose()) {
      // A clean page also needs a fresh lifetime for its replacement read.
      renewActivity();
      if (isUnresolvedMembership(command, observed)) await reviewRecovery(cursor);
      else await reload(cursor);
    }
  }
  function retainUnknown(command: MembershipCommand, kind: string, result?: MembershipPage) {
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
  async function reload(cursor?: string) {
    const isActive = activity.current;
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
      if (saved?.unresolved) {
        retainUnknown(saved, 'review');
      }
      const session = await loadAccountSession();
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
        if (saved?.unresolved) {
          retainUnknown(saved, session.kind, { kind: session.kind === 'signed-out' ? 'signed-out' : 'unavailable' });
          return;
        }
        installPage({ kind: session.kind === 'signed-out' ? 'signed-out' : 'unavailable' });
        return;
      }
      const initiatingAccount = saved?.accountId ?? (accountId || session.accountId);
      if (session.accountId !== initiatingAccount) {
        if (saved?.unresolved) {
          retainUnknown(saved, 'denied', { kind: 'unavailable' });
          return;
        }
        installPage({ kind: 'denied' });
        return;
      }
      setAccountId(initiatingAccount);
      const matchingProfile = membershipSessionMatches(session, initiatingAccount);
      setNeedsProfile(!matchingProfile);
      if (saved?.unresolved) {
        retainUnknown(saved, matchingProfile ? 'review' : 'signed-out');
        return;
      }
      if (saved) {
        setCommand(saved);
        setReviewCurrent(true);
        setNotice('step-up');
      }
      const result = await loadMembershipPage(organizationId, initiatingAccount, cursor);
      if (isActive()) installPage(result);
    } finally {
      if (isActive()) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  async function reviewRecovery(cursor?: string) {
    const isActive = activity.current;
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
      const session = await loadAccountSession();
      if (!isActive()) return;
      if (!membershipSessionMatches(session, expected.accountId)) {
        const kind = session.kind === 'signed-out' ? 'signed-out' : session.kind === 'ready' ? 'denied' : 'unavailable';
        installPage({ kind });
        return;
      }
      const currentPage = await loadMembershipPage(organizationId, expected.accountId, cursor);
      if (!isActive()) return;
      if (currentPage.kind !== 'ready') {
        installPage(currentPage);
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
        const resultPage = await loadMembershipPage(organizationId, accountId);
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
      if (!observedResult && command.unresolved && !membershipReservationMatches(command, current)) {
        retirePrivateAuthority('conflict');
        setPage({ kind: 'conflict' });
        return;
      }
      const resultPage = await loadMembershipPage(organizationId, accountId);
      if (isActive()) {
        if (!observedResult && command.unresolved && !membershipPageAllowsCommand(resultPage, command)) {
          retirePrivateAuthority('denied');
          setPage({ kind: resultPage.kind === 'ready' ? 'denied' : resultPage.kind });
        } else {
          setReviewCurrent(!observedResult && command.unresolved);
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
        } else setNotice('unavailable');
        return;
      }
      setReauth(false);
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
        const result = await loadMembershipPage(organizationId, accountId);
        if (isActive()) installPage(result);
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
  return (
    <AuthPage heading={m.auth_members_heading()}>
      {router ? (
        <Link to="/security" className="inline-flex min-h-11 items-center underline underline-offset-4">
          {m.auth_members_back()}
        </Link>
      ) : null}
      {router ? <MembershipNavigation choose={choose} /> : null}
      {departing ? <DepartureChoice answer={answer} focusFallback={focusRecovery} /> : null}
      <p>{m.auth_members_intro()}</p>
      {!recoveryVisible && page?.kind === 'ready' ? <p className="break-all">{organizationId}</p> : null}
      <div aria-busy={busy || page === null} className="space-y-5">
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
            retry={() => void reviewRecovery()}
            signIn={beginRecoverySignIn}
            headingRef={recoveryHeading}
          />
        ) : page?.kind !== 'ready' ? (
          <div className="space-y-3" role="status">
            <p>{statusMessage(page?.kind ?? 'loading')}</p>
            {page && page.kind !== 'signed-out' && page.kind !== 'denied' && page.kind !== 'missing' ? (
              <Button type="button" variant="outline" disabled={busy} onClick={() => void browse()}>
                {m.auth_inventory_reload()}
              </Button>
            ) : null}
          </div>
        ) : (
          <OrganizationMembershipRoster
            page={page}
            busy={busy}
            pending={!!command}
            onSelect={(target, role) => void select(target, role)}
            onReload={(cursor) => void browse(cursor)}
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
        {command && !revoked && !recoveryVisible ? (
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
                    disabled={busy || observed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  {m.auth_members_confirm_check()}
                </label>
                <Button type="submit" aria-busy={busy} disabled={busy || !confirmed || observed}>
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
              {observed ? m.auth_members_close() : m.auth_inventory_cancel()}
            </Button>
          </section>
        ) : null}
      </div>
    </AuthPage>
  );
}
