import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Alert, AlertDescription } from '@rezics/ui/shadcn/alert';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { AuthButton as Button } from '../button';
import { AuthPage } from '../frame';
import { PasswordInput } from '../password-input';
import { loadAccountSession } from '../account-operations';
import { m } from '../paraglide/messages.js';
import {
  clearMembershipCommand,
  loadMembershipPage,
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
  return <OrganizationMembersPage key={organizationId} organizationId={organizationId} />;
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
export function OrganizationMembersPage({ organizationId }: { organizationId: string }) {
  const [page, setPage] = useState<MembershipPage | null>(null);
  const [accountId, setAccountId] = useState('');
  const [command, setCommand] = useState<MembershipCommand | null>(null);
  const [member, setMember] = useState('');
  const [role, setRole] = useState<'owner' | 'member'>('member');
  const [confirmed, setConfirmed] = useState(false);
  const [needsProfile, setNeedsProfile] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [reauth, setReauth] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [observed, setObserved] = useState(false);
  const lock = useRef(false);
  const feedback = useRef<HTMLDivElement>(null);
  const confirmation = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let active = true;
    setPage(null);
    setCommand(null);
    setConfirmed(false);
    setReauth(false);
    setNotice('');
    void (async () => {
      if (!membershipId(organizationId)) {
        if (active) setPage({ kind: 'missing' });
        return;
      }
      const session = await loadAccountSession();
      if (!active) return;
      if (session.kind !== 'ready') {
        setPage({ kind: session.kind === 'signed-out' ? 'signed-out' : 'unavailable' });
        return;
      }
      const saved = readMembershipCommand();
      if (
        saved === 'invalid' ||
        (saved && (saved.accountId !== session.accountId || saved.operation.organizationId !== organizationId))
      ) {
        setPage({ kind: 'unavailable' });
        return;
      }
      setAccountId(session.accountId);
      setNeedsProfile(!membershipSessionMatches(session, session.accountId));
      if (saved) {
        setCommand(saved);
        setNotice(saved.unresolved ? 'unknown' : 'step-up');
      }
      const result = await loadMembershipPage(organizationId, session.accountId);
      if (active) setPage(result);
    })();
    return () => {
      active = false;
    };
  }, [organizationId]);
  useLayoutEffect(() => {
    if (notice) feedback.current?.focus();
  }, [notice]);
  useLayoutEffect(() => {
    if (command) confirmation.current?.focus();
  }, [command?.operationKey]);

  async function reload(cursor?: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setPage(null);
    try {
      setPage(await loadMembershipPage(organizationId, accountId, cursor));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function select(memberAccountId: string, desired: 'owner' | 'member' | null, reservationId?: string) {
    if (lock.current || command || !membershipId(memberAccountId) || page?.kind !== 'ready') return;
    const current = page.holders.find((row) => row.accountId === memberAccountId);
    if ((current && (!reservationId || current.role === desired)) || (desired === null && !reservationId)) return;
    const next = newMembershipCommand(accountId, {
      kind: 'membership',
      organizationId,
      memberAccountId,
      role: desired,
      ...(reservationId ? { reservationId } : {}),
    });
    if (!saveMembershipCommand(next)) {
      setNotice('unavailable');
      return;
    }
    setCommand(next);
    setConfirmed(false);
    setNotice('');
    setObserved(false);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current || !command || !confirmed || page?.kind !== 'ready') return;
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
      const result: MembershipOutcome = await submitMembership(command);
      setNotice(result);
      setConfirmed(false);
      if (result === 'step-up') setReauth(true);
      // Every attempt replaces the displayed list with a fresh native read,
      // including denials and uncertain writes. Never patch holders optimistically.
      setPage(null);
      const current = await loadMembershipPage(organizationId, accountId);
      setPage(current);
      setObserved(
        result === 'acknowledged' &&
          current.kind === 'ready' &&
          (command.operation.role === null
            ? current.next === null &&
              !current.holders.some((row) => row.accountId === command.operation.memberAccountId)
            : current.holders.some(
                (row) => row.accountId === command.operation.memberAccountId && row.role === command.operation.role,
              )),
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function authenticate(event: FormEvent) {
    event.preventDefault();
    if (lock.current || !command || !email || !password) return;
    lock.current = true;
    setBusy(true);
    try {
      if (!(await reauthenticateMembership(command, email, password))) {
        setPage({ kind: 'unavailable' });
        setNotice('unavailable');
        return;
      }
      setReauth(false);
      setNeedsProfile(false);
      setConfirmed(false);
      setNotice('step-up');
      setPage(null);
      setPage(await loadMembershipPage(organizationId, accountId));
    } finally {
      setPassword('');
      lock.current = false;
      setBusy(false);
    }
  }
  function dismiss() {
    if (busy || !command || (command.unresolved && !observed)) return;
    try {
      clearMembershipCommand();
    } catch {
      setNotice('unavailable');
      return;
    }
    setCommand(null);
    setNotice('');
    setReauth(false);
    setConfirmed(false);
    setObserved(false);
  }
  const effect =
    command?.operation.role === null
      ? m.auth_members_remove_effect()
      : command?.operation.role === 'owner'
        ? m.auth_members_owner_effect()
        : m.auth_members_member_effect();
  return (
    <AuthPage heading={m.auth_members_heading()}>
      <p>{m.auth_members_intro()}</p>
      <p className="break-all">{organizationId}</p>
      <div aria-busy={busy || page === null} className="space-y-5">
        {notice ? (
          <div ref={feedback} tabIndex={-1} role="status">
            <Alert>
              <AlertDescription>{statusMessage(notice)}</AlertDescription>
            </Alert>
          </div>
        ) : null}
        {page?.kind !== 'ready' ? (
          <p role="status">{statusMessage(page?.kind ?? 'loading')}</p>
        ) : (
          <>
            <ul className="divide-y" aria-label={m.auth_members_holders()}>
              {page.holders.map((holder) => (
                <li key={holder.accountId} className="space-y-2 py-3">
                  <p className="break-all">{holder.accountId}</p>
                  <p>{holder.role === 'owner' ? m.auth_members_owner() : m.auth_members_member()}</p>
                  {holder.reservationId ? (
                    <p className="break-all">{m.auth_members_reservation({ reservation: holder.reservationId })}</p>
                  ) : (
                    <p>{m.auth_members_no_reservation()}</p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy || !!command || !holder.reservationId}
                      onClick={() =>
                        select(holder.accountId, holder.role === 'owner' ? 'member' : 'owner', holder.reservationId)
                      }
                    >
                      {m.auth_members_change_role()}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy || !!command || !holder.reservationId}
                      onClick={() => select(holder.accountId, null, holder.reservationId)}
                    >
                      {m.auth_members_remove()}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            {!page.holders.length ? <p>{m.auth_members_empty_page()}</p> : null}
            <nav className="flex flex-wrap gap-2" aria-label={m.auth_members_holders()}>
              <Button type="button" variant="outline" disabled={busy} onClick={() => void reload()}>
                {m.auth_inventory_reload()}
              </Button>
              {page.next ? (
                <Button type="button" variant="outline" disabled={busy} onClick={() => void reload(page.next!)}>
                  {m.auth_inventory_next()}
                </Button>
              ) : null}
            </nav>
            {!command ? (
              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  select(member, role);
                }}
              >
                <Field>
                  <FieldLabel htmlFor="membership-account">{m.auth_members_target()}</FieldLabel>
                  <Input
                    id="membership-account"
                    required
                    value={member}
                    disabled={busy}
                    onChange={(event) => setMember(event.target.value)}
                    pattern="[0-9a-fA-F-]{36}"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="membership-role">{m.auth_members_role()}</FieldLabel>
                  <select
                    id="membership-role"
                    value={role}
                    disabled={busy}
                    onChange={(event) => setRole(event.target.value as 'owner' | 'member')}
                    className="min-h-11 rounded-md border bg-background px-3"
                  >
                    <option value="member">{m.auth_members_member()}</option>
                    <option value="owner">{m.auth_members_owner()}</option>
                  </select>
                </Field>
                <Button
                  type="submit"
                  disabled={busy || !membershipId(member) || page.holders.some((row) => row.accountId === member)}
                >
                  {m.auth_members_review_add()}
                </Button>
              </form>
            ) : null}
          </>
        )}
        {command ? (
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
            <p>{m.auth_members_authority()}</p>
            {reauth ? (
              <form onSubmit={(event) => void authenticate(event)} className="space-y-4">
                <Field>
                  <FieldLabel htmlFor="membership-email">{m.auth_login_email()}</FieldLabel>
                  <Input
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
              </form>
            ) : (
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
                <Button
                  type="submit"
                  aria-busy={busy}
                  disabled={busy || !confirmed || observed || page?.kind !== 'ready'}
                >
                  {command.unresolved ? m.auth_members_retry_exact() : m.auth_members_submit()}
                </Button>
              </form>
            )}
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
        {page && page.kind !== 'ready' ? (
          <Button type="button" variant="outline" disabled={busy || !accountId} onClick={() => void reload()}>
            {m.auth_inventory_reload()}
          </Button>
        ) : null}
      </div>
    </AuthPage>
  );
}
