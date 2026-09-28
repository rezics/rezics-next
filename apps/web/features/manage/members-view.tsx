'use client';

import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import { Field, FieldError, FieldHelper, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@rezics/ui/menu';
import { ChoiceSelect } from '@rezics/ui/select';
import { Textarea } from '@rezics/ui/textarea';
import { BanIcon, EllipsisIcon, SearchIcon, UserPlusIcon, UsersIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import { type AdminApi, bffAdminApi, useRoleChange } from './admin-api.ts';
import { CommandDialog } from './command-dialog.tsx';
import type { CommandFailure } from './commands.ts';
import { newKey } from './commands.ts';
import { agentLabel, date, shownHandle } from './format.ts';
import { ImpactPreview } from './impact-preview.tsx';
import type { ManageMessages } from './messages.ts';
import { AgentMark } from './parts.tsx';
import { mergeAgents } from './read.ts';
import { REASON_LIMIT } from './reason-dialog.tsx';
import type { AgentSummary, InvitationPage, Loaded, Member, MemberPage, Role, RoleChange } from './types.ts';

/** Ban lengths moderators choose from (Main allows up to 366 days, or no end). */
export const banDurations = [['duration1d', 86_400], ['duration3d', 259_200], ['duration7d', 604_800],
  ['duration30d', 2_592_000], ['duration365d', 31_536_000], ['durationForever', null]] as const;
/** How long an invitation stays open (Main allows up to a week, and never past the inviter's own access). */
export const inviteDurations = [['duration1d', 86_400], ['duration3d', 259_200], ['duration7d', 604_800]] as const;
/** How long a role is given for. It cannot outlast the giver's own access. */
export const roleDurations = [['validFor7', 7], ['validFor30', 30], ['validFor90', 90], ['validFor365', 365]] as const;

type Target = { iri: string; membershipGeneration: string; member: Member | null };
type Open =
  | { kind: 'ban' | 'unban'; target: Target | null }
  | { kind: 'remove'; target: Target }
  | { kind: 'invite' }
  | { kind: 'give'; target: Target }
  | { kind: 'take'; target: Target; role: { id: string; name: string } };

export function failureText(failure: CommandFailure | 'changed', t: ReturnType<typeof materializeData<ManageMessages>>,
  subject: 'member' | 'role') {
  if (failure === 'stale') return subject === 'member' ? t.memberStale : t.impactStale;
  if (failure === 'denied') return subject === 'member' ? t.memberDenied : t.roleDenied;
  if (failure === 'budget') return t.roleLimit;
  if (failure === 'changed') return t.impactStale;
  if (failure === 'sign-in') return t.signInHelp;
  return t.failedNotice;
}

/**
 * Members of the Realm: search by name or handle, invite people, remove, ban
 * and unban them, and give or take roles with the impact shown first.
 */
export function MembersView({ realm, actingSubject, first, agents: initialAgents, roles, now, locale, messages,
  invitations: firstInvitations, api: givenApi }: {
  realm: string; actingSubject: string; first: MemberPage; agents: Record<string, AgentSummary>;
  invitations: Loaded<InvitationPage>;
  /** Roles the person may give, or null without the Manage roles permission. */
  roles: readonly Role[] | null; now: number; locale: UiLocale; messages: ManageMessages; api?: AdminApi;
}) {
  const t = useMemo(() => materializeData(messages, { locale }), [messages, locale]);
  const api = useMemo(() => givenApi ?? bffAdminApi(realm, actingSubject), [givenApi, realm, actingSubject]);
  const router = useRouter();
  const [page, setPage] = useState(first);
  const [invitations, setInvitations] = useState(firstInvitations);
  const [invitationBusy, setInvitationBusy] = useState<string | null>(null);
  const [agents, setAgents] = useState(initialAgents);
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState('');
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState<Open | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const nameOf = (iri: string) => agentLabel(agents[iri], iri, id => t.agentFallback({ id }));

  async function load(search: string, after: string | null = null) {
    setSearching(true);
    const read = await api.members(search, after);
    setSearching(false);
    if (!read.ok) { setStatus(t.unavailableTitle); return; }
    setPage(current => after ? { ...read.data, items: [...current.items, ...read.data.items] } : read.data);
    setSearched(search);
    const found = await api.names(read.data.items.map(item => item.member));
    setAgents(known => mergeAgents(known, found));
  }

  function search(event: FormEvent) {
    event.preventDefault();
    void load(query.trim());
  }

  async function done(message: string) {
    setOpen(null);
    setStatus(message);
    router.refresh();
    await load(searched);
    const refreshed = await api.invitations(null);
    setInvitations(refreshed);
  }

  async function loadInvitations(after: string) {
    setInvitationBusy(after);
    const read = await api.invitations(after);
    setInvitationBusy(null);
    if (!read.ok) { setStatus(t.unavailableTitle); return; }
    setInvitations(current => current.ok ? { ok: true, data: { ...read.data,
      items: [...current.data.items, ...read.data.items] } } : read);
    const found = await api.names(read.data.items.map(item => item.member));
    setAgents(known => mergeAgents(known, found));
  }

  async function cancelInvitation(id: string) {
    setInvitationBusy(id);
    const result = await api.revoke(id, newKey());
    setInvitationBusy(null);
    if (!result.ok) { setStatus(result.failure === 'stale' ? t.invitationStale : t.invitationCancelFailed); return; }
    setInvitations(current => current.ok ? { ok: true, data: { ...current.data,
      items: current.data.items.map(item => item.id === id ? result.data.invitation : item) } } : current);
    setStatus(t.invitationCancelled({ name: nameOf(result.data.invitation.member) }));
  }

  const target = (member: Member): Target => ({ iri: member.member, membershipGeneration: member.membershipGeneration,
    member });
  return <div className="grid gap-5">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="space-y-1">
        <h2 className="font-semibold text-xl tracking-tight">{t.membersTitle}</h2>
        <p className="max-w-2xl text-muted-foreground text-sm">{t.membersHelp}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" size="sm" onClick={() => setOpen({ kind: 'unban', target: null })}>{t.unbanSomeone}</Button>
        <Button variant="outline" size="sm" onClick={() => setOpen({ kind: 'ban', target: null })}>
          <BanIcon aria-hidden="true" />{t.banSomeone}</Button>
        <Button size="sm" onClick={() => setOpen({ kind: 'invite' })}><UserPlusIcon aria-hidden="true" />{t.inviteMember}</Button>
      </div>
    </div>
    <form role="search" aria-label={t.searchMembers} onSubmit={search} className="flex max-w-xl gap-2">
      <Field className="flex-1">
        <FieldLabel className="sr-only">{t.searchMembers}</FieldLabel>
        <Input type="search" value={query} placeholder={t.searchMembersPlaceholder} maxLength={80}
          onChange={event => setQuery(event.currentTarget.value)} />
      </Field>
      <Button type="submit" variant="secondary" isLoading={searching}><SearchIcon aria-hidden="true" />{t.search}</Button>
      {searched ? <Button type="button" variant="ghost" onClick={() => { setQuery(''); void load(''); }}>{t.clearSearch}</Button>
        : null}
    </form>
    <div role="status" aria-live="polite" className="empty:hidden">{status ? <p className="text-sm">{status}</p> : null}</div>
    {!page.items.length ? <EmptyState icon={UsersIcon}
      title={searched ? t.noMemberMatches({ query: searched }) : t.noMembersTitle}
      description={searched ? undefined : t.noMembersHelp} />
      : <ul aria-label={t.membersTitle} className="grid divide-y divide-border/60 rounded-2xl border border-border/60 bg-card">
        {page.items.map(member => {
          const name = nameOf(member.member);
          const handle = shownHandle(agents[member.member]?.handle ?? null);
          return <li key={member.member} className="relative grid gap-3 py-3.5 ps-4 pe-12 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] sm:pe-4
            sm:items-center">
            <div className="flex min-w-0 items-center gap-3">
              <AgentMark name={name} iri={member.member} />
              <div className="min-w-0">
                <p className="truncate font-medium">{name}</p>
                <p className="truncate text-muted-foreground text-xs">{[handle, member.state === 'joined'
                  ? member.joinedAt ? `${t.memberJoined} · ${date(member.joinedAt, locale)}` : t.memberJoined
                  : member.state === 'not_joined' ? t.memberNotJoined : t.memberLeft].filter(Boolean).join(' · ')}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {member.banned ? <Badge variant="destructive">{member.bannedUntil
                ? t.bannedUntil({ date: date(member.bannedUntil, locale) }) : t.bannedPermanently}</Badge> : null}
              {member.roles.length ? member.roles.map(role => <Badge key={role.id} variant="secondary"
                title={t.roleUntil({ date: date(role.validUntil, locale) })}>{role.name}</Badge>)
                : <span className="text-muted-foreground text-sm">{t.noRoles}</span>}
            </div>
            <Menu onSelect={({ value }) => {
              const chosen = target(member);
              if (value === 'ban') setOpen({ kind: 'ban', target: chosen });
              else if (value === 'unban') setOpen({ kind: 'unban', target: chosen });
              else if (value === 'remove') setOpen({ kind: 'remove', target: chosen });
              else if (value === 'give') setOpen({ kind: 'give', target: chosen });
              else if (value.startsWith('take:')) {
                const role = member.roles.find(item => `take:${item.id}` === value);
                if (role) setOpen({ kind: 'take', target: chosen, role });
              }
            }}>
              <MenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t.memberActions({ name })}
                  className="absolute end-3 top-3 sm:static">
                  <EllipsisIcon aria-hidden="true" /></Button>
              </MenuTrigger>
              <MenuContent>
                {roles && !member.banned ? <MenuItem value="give">{t.giveRoleAction}</MenuItem> : null}
                {roles ? member.roles.map(role => <MenuItem key={role.id} value={`take:${role.id}`}>
                  {t.takeRoleAction({ role: role.name })}</MenuItem>) : null}
                {roles ? <MenuSeparator /> : null}
                {member.banned ? <MenuItem value="unban">{t.unbanAction}</MenuItem>
                  : <MenuItem value="ban">{t.banAction}</MenuItem>}
                {member.state === 'joined' ? <MenuItem value="remove">{t.removeAction}</MenuItem> : null}
              </MenuContent>
            </Menu>
          </li>;
        })}
      </ul>}
    {page.nextCursor ? <div><Button variant="outline" size="sm" isLoading={searching}
      onClick={() => void load(searched, page.nextCursor)}>{t.loadMore}</Button></div> : null}
    <section aria-labelledby="outgoing-invitations" className="grid gap-3">
      <h2 id="outgoing-invitations" className="font-semibold text-lg">{t.outgoingInvitations}</h2>
      {!invitations.ok ? <p role="alert" className="text-muted-foreground text-sm">{t.invitationsUnavailable}</p>
        : invitations.data.items.length ? <ul className="grid divide-y divide-border/60 rounded-2xl border border-border/60 bg-card">
          {invitations.data.items.map(invitation => <li key={invitation.id}
            className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
            <div className="min-w-0">
              <p className="font-medium">{nameOf(invitation.member)}</p>
              <p className="text-muted-foreground text-sm">{{ pending: t.invitationPending, expired: t.invitationExpired,
                accepted: t.invitationAccepted, declined: t.invitationDeclined, revoked: t.invitationRevoked }[invitation.state]} · {t.invitationExpiry({
                date: date(invitation.expiresAt, locale) })}</p>
            </div>
            {invitation.state === 'pending' && Date.parse(invitation.expiresAt) > now
              ? <Button variant="outline" size="sm" isLoading={invitationBusy === invitation.id}
                disabled={invitationBusy !== null} onClick={() => void cancelInvitation(invitation.id)}>
                {t.cancelInvitation}</Button> : null}
          </li>)}
        </ul> : <p className="text-muted-foreground text-sm">{t.noOutgoingInvitations}</p>}
      {invitations.ok && invitations.data.nextCursor ? <Button variant="outline" size="sm"
        className="justify-self-start" isLoading={invitationBusy === invitations.data.nextCursor}
        onClick={() => void loadInvitations(invitations.data.nextCursor!)}>{t.loadMore}</Button> : null}
    </section>
    {open?.kind === 'give' || open?.kind === 'take'
      ? <RoleDialog open={open} generation={page.generation} roles={roles ?? []} api={api} actingSubject={actingSubject}
        agents={agents} name={nameOf(open.target.iri)} now={now} locale={locale} messages={messages}
        onClose={() => setOpen(null)} onDone={message => void done(message)} />
      : <MemberDialog open={open} generation={page.generation} api={api} actingSubject={actingSubject} nameOf={nameOf}
        locale={locale} messages={messages} onClose={() => setOpen(null)} onDone={message => void done(message)}
        onLearn={agent => setAgents(known => ({ ...known, [agent.iri]: agent }))} />}
  </div>;
}

function MemberDialog({ open, generation, api, actingSubject, nameOf, locale, messages, onClose, onDone, onLearn }: {
  open: Exclude<Open, { kind: 'give' | 'take' }> | null; generation: string; api: AdminApi; actingSubject: string;
  nameOf: (iri: string) => string; locale: UiLocale; messages: ManageMessages; onClose: () => void;
  onDone: (message: string) => void; onLearn: (agent: AgentSummary) => void;
}) {
  const t = materializeData(messages, { locale });
  const [who, setWho] = useState('');
  const [duration, setDuration] = useState('duration7d');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [field, setField] = useState<'who' | 'reason' | null>(null);
  const [pending, setPending] = useState(false);
  const key = useRef(newKey());
  const whoRef = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!open) return;
    setWho(''); setDuration('duration7d'); setReason(''); setError(null); setField(null);
    key.current = newKey();
  }, [open]);

  const kind = open?.kind;
  const known = open && 'target' in open ? open.target : null;
  const name = known ? nameOf(known.iri) : '';
  const title = kind === 'ban' ? known ? t.banTitle({ name }) : t.banSomeoneTitle
    : kind === 'unban' ? known ? t.unbanTitle({ name }) : t.unbanSomeoneTitle
      : kind === 'remove' ? t.removeTitle({ name }) : t.inviteTitle;
  const help = kind === 'ban' ? t.banHelp : kind === 'unban' ? t.unbanHelp : kind === 'remove' ? t.removeHelp : t.inviteHelp;
  const confirm = kind === 'ban' ? t.banConfirm : kind === 'unban' ? t.unbanConfirm : kind === 'remove' ? t.removeConfirm
    : t.inviteConfirm;

  async function submit() {
    if (!open) return;
    setError(null); setField(null);
    if ((open.kind === 'invite' || (open.kind === 'ban' || open.kind === 'unban') && !open.target) && !who.trim()) {
      setField('who');
      return;
    }
    // An invitation carries no reason: the invitee decides.
    if (open.kind !== 'invite' && (!reason.trim() || reason.trim().length > REASON_LIMIT)) { setField('reason'); return; }
    setPending(true);
    let subject = known;
    let label: string | null = null;
    if (!subject) {
      const found = await api.lookup(who);
      if (!found.ok) { setPending(false); setField('who'); return; }
      onLearn(found.data);
      label = found.data.label;
      // Someone already on the roster is changed at their own membership generation.
      const roster = await api.members(found.data.iri, null);
      const row = roster.ok ? roster.data.items.find(item => item.member === found.data.iri) : undefined;
      subject = { iri: found.data.iri, membershipGeneration: row?.membershipGeneration ?? '0', member: row ?? null };
    }
    if (open.kind === 'invite') {
      const seconds = inviteDurations.find(([label]) => label === duration)?.[1] ?? 604_800;
      const sent = await api.invite({ actingSubject, member: subject.iri, expiresInSeconds: seconds }, key.current);
      setPending(false);
      if (!sent.ok) {
        setError(sent.failure === 'denied' ? t.inviteDenied : failureText(sent.failure, t, 'member'));
        if (sent.failure === 'stale') key.current = newKey();
        return;
      }
      onDone(t.invitedNow({ name: label ?? nameOf(subject.iri), date: date(sent.data.invitation.expiresAt, locale) }));
      return;
    }
    const seconds = banDurations.find(([label]) => label === duration)?.[1] ?? null;
    const result = await api.changeMember({ actingSubject, expectedGeneration: generation, reason: reason.trim(),
      member: subject.iri, expectedMembershipGeneration: subject.membershipGeneration, action: open.kind,
      consent: null, durationSeconds: open.kind === 'ban' ? seconds : null },
    key.current);
    setPending(false);
    if (!result.ok) {
      // Main does not list bans of people outside the roster; a refused unban means there was none.
      setError(open.kind === 'unban' && !known && result.failure === 'denied' ? t.notBanned
        : failureText(result.failure, t, 'member'));
      if (result.failure === 'stale') key.current = newKey();
      return;
    }
    const shown = label ?? nameOf(subject.iri);
    onDone(open.kind === 'ban' ? subject.member ? t.bannedNow({ name: shown }) : t.bannedOutsider({ name: shown }) : open.kind === 'unban' ? t.unbannedNow({ name: shown })
      : t.removedNow({ name: shown }));
  }

  return <CommandDialog open={open !== null} title={title} description={help} confirm={confirm}
    destructive={kind === 'ban' || kind === 'remove'} pending={pending} error={error} cancel={t.cancel}
    onClose={onClose} onConfirm={() => void submit()}
    initialFocus={() => whoRef.current ?? reasonRef.current}>
    {kind === 'invite' || (kind === 'ban' || kind === 'unban') && !known ? <Field invalid={field === 'who'}>
      <FieldLabel>{t.whoLabel}</FieldLabel>
      <Input ref={whoRef} value={who} placeholder={t.whoPlaceholder} autoComplete="off"
        onChange={event => setWho(event.currentTarget.value)} />
      {field === 'who' ? <FieldError>{t.whoNotFound}</FieldError> : <FieldHelper>{t.whoHelp}</FieldHelper>}
    </Field> : null}
    {kind === 'invite' ? <Field>
      <FieldLabel>{t.inviteExpiresLabel}</FieldLabel>
      <ChoiceSelect portalled={false} value={duration} onValueChange={setDuration} options={inviteDurations.map(([label]) =>
        ({ value: label, label: t[label] }))} />
    </Field> : null}
    {kind === 'ban' ? <Field>
      <FieldLabel>{t.durationLabel}</FieldLabel>
      <ChoiceSelect portalled={false} value={duration} onValueChange={setDuration} options={banDurations.map(([label]) =>
        ({ value: label, label: t[label] }))} />
    </Field> : null}
    {kind === 'invite' ? null : <Field invalid={field === 'reason'}>
      <FieldLabel>{kind === 'ban' ? t.banReasonLabel : t.changeReasonLabel}</FieldLabel>
      <Textarea ref={reasonRef} value={reason} rows={3} maxLength={REASON_LIMIT + 200}
        onChange={event => setReason(event.currentTarget.value)} />
      {field === 'reason' ? <FieldError>{reason.trim() ? t.reasonTooLong : t.reasonRequired}</FieldError>
        : <FieldHelper>{kind === 'ban' ? t.banReasonHelp : t.changeReasonHelp}</FieldHelper>}
    </Field>}
  </CommandDialog>;
}

function RoleDialog({ open, generation, roles, api, actingSubject, agents, name, now, locale, messages, onClose, onDone }: {
  open: Extract<Open, { kind: 'give' | 'take' }>; generation: string; roles: readonly Role[]; api: AdminApi;
  actingSubject: string; agents: Record<string, AgentSummary>; name: string; now: number; locale: UiLocale;
  messages: ManageMessages; onClose: () => void; onDone: (message: string) => void;
}) {
  const t = materializeData(messages, { locale });
  const held = new Set(open.target.member?.roles.map(role => role.id) ?? []);
  const choices = roles.filter(role => !held.has(role.id));
  const [roleId, setRoleId] = useState(open.kind === 'take' ? open.role.id : choices[0]?.id ?? '');
  const [days, setDays] = useState<number>(30);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [openedAt] = useState(() => Math.max(now, Date.now()));
  const change = useMemo<RoleChange | null>(() => roleId ? { kind: 'assignment', roleId, member: open.target.iri,
    assigned: open.kind === 'give',
    validUntil: new Date(openedAt + (open.kind === 'give' ? days * 86_400_000 : 0)).toISOString() } : null,
  [roleId, open, days, openedAt]);
  const { state, save, names } = useRoleChange(api, { actingSubject, generation, change });
  const roleName = open.kind === 'take' ? open.role.name : roles.find(role => role.id === roleId)?.name ?? '';

  async function submit() {
    if (!reason.trim()) { setError(t.reasonRequired); return; }
    setPending(true); setError(null);
    const result = await save(reason);
    setPending(false);
    if (!result.ok) {
      setError(failureText(result.failure, t, 'role'));
      return;
    }
    onDone(open.kind === 'give' ? t.roleGiven({ name, role: roleName }) : t.roleTaken({ name, role: roleName }));
  }

  return <CommandDialog open title={open.kind === 'give' ? t.giveRoleTitle({ name }) : t.takeRoleTitle({ role: roleName, name })}
    confirm={open.kind === 'give' ? t.giveRole : t.takeRole} destructive={open.kind === 'take'} pending={pending}
    error={error} cancel={t.cancel} onClose={onClose} onConfirm={() => void submit()}
    disabled={state.kind !== 'ready' || !roleId}>
    {open.kind === 'give' ? <div className="grid gap-4 sm:grid-cols-2">
      <Field>
        <FieldLabel>{t.roleLabel}</FieldLabel>
        <ChoiceSelect portalled={false} value={roleId} onValueChange={setRoleId} className="w-full"
          options={choices.map(role => ({ value: role.id, label: role.name }))} />
      </Field>
      <Field>
        <FieldLabel>{t.validForLabel}</FieldLabel>
        <ChoiceSelect portalled={false} value={String(days)} onValueChange={value => setDays(Number(value))} className="w-full"
          options={roleDurations.map(([label, value]) => ({ value: String(value), label: t[label] }))} />
      </Field>
    </div> : null}
    <ImpactPreview state={state} agents={mergeAgents(agents, names)} actingSubject={actingSubject} locale={locale}
      messages={messages} />
    <Field invalid={error === t.reasonRequired}>
      <FieldLabel>{t.changeReasonLabel}</FieldLabel>
      <Textarea value={reason} rows={2} maxLength={REASON_LIMIT} onChange={event => setReason(event.currentTarget.value)} />
      <FieldHelper>{t.changeReasonHelp}</FieldHelper>
    </Field>
  </CommandDialog>;
}
