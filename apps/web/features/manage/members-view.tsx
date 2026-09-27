'use client';

import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import { Field, FieldError, FieldHelper, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@rezics/ui/menu';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/native-select';
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
import { REASON_LIMIT } from './reason-dialog.tsx';
import type { AgentSummary, Member, MemberPage, Role, RoleChange } from './types.ts';

/** Ban lengths moderators choose from (Main allows up to 366 days, or no end). */
export const banDurations = [['duration1d', 86_400], ['duration3d', 259_200], ['duration7d', 604_800],
  ['duration30d', 2_592_000], ['duration365d', 31_536_000], ['durationForever', null]] as const;
/** How long a role is given for. It cannot outlast the giver's own access. */
export const roleDurations = [['validFor7', 7], ['validFor30', 30], ['validFor90', 90], ['validFor365', 365]] as const;

type Target = { iri: string; membershipGeneration: string; member: Member | null };
type Open =
  | { kind: 'ban'; target: Target | null }
  | { kind: 'unban' | 'remove'; target: Target }
  | { kind: 'add' }
  | { kind: 'give'; target: Target }
  | { kind: 'take'; target: Target; role: { id: string; name: string } };

const consentPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
 * Members of the Realm: search by name or handle, and add, remove, ban and
 * unban people, and give or take roles with the impact shown first.
 */
export function MembersView({ realm, actingSubject, first, agents: initialAgents, roles, now, locale, messages,
  api: givenApi }: {
  realm: string; actingSubject: string; first: MemberPage; agents: Record<string, AgentSummary>;
  /** Roles the person may give, or null without the Manage roles permission. */
  roles: readonly Role[] | null; now: number; locale: UiLocale; messages: ManageMessages; api?: AdminApi;
}) {
  const t = useMemo(() => materializeData(messages, { locale }), [messages, locale]);
  const api = useMemo(() => givenApi ?? bffAdminApi(realm, actingSubject), [givenApi, realm, actingSubject]);
  const router = useRouter();
  const [page, setPage] = useState(first);
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
    setAgents(known => ({ ...known, ...found }));
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
        <Button variant="outline" size="sm" onClick={() => setOpen({ kind: 'ban', target: null })}>
          <BanIcon aria-hidden="true" />{t.banSomeone}</Button>
        <Button size="sm" onClick={() => setOpen({ kind: 'add' })}><UserPlusIcon aria-hidden="true" />{t.addMember}</Button>
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
          return <li key={member.member} className="grid gap-3 px-4 py-3.5 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto]
            sm:items-center">
            <div className="flex min-w-0 items-center gap-3">
              <AgentMark name={name} iri={member.member} />
              <div className="min-w-0">
                <p className="truncate font-medium">{name}</p>
                <p className="truncate text-muted-foreground text-xs">{[handle, member.state === 'joined'
                  ? member.joinedAt ? `${t.memberJoined} · ${date(member.joinedAt, locale)}` : t.memberJoined
                  : t.memberLeft].filter(Boolean).join(' · ')}</p>
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
              else if (value === 'unban' || value === 'remove') setOpen({ kind: value, target: chosen });
              else if (value === 'give') setOpen({ kind: 'give', target: chosen });
              else if (value.startsWith('take:')) {
                const role = member.roles.find(item => `take:${item.id}` === value);
                if (role) setOpen({ kind: 'take', target: chosen, role });
              }
            }}>
              <MenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t.memberActions({ name })}>
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
  const [consent, setConsent] = useState('');
  const [duration, setDuration] = useState('duration7d');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [field, setField] = useState<'who' | 'consent' | 'reason' | null>(null);
  const [pending, setPending] = useState(false);
  const key = useRef(newKey());
  const whoRef = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!open) return;
    setWho(''); setConsent(''); setDuration('duration7d'); setReason(''); setError(null); setField(null);
    key.current = newKey();
  }, [open]);

  const kind = open?.kind;
  const known = open && 'target' in open ? open.target : null;
  const name = known ? nameOf(known.iri) : '';
  const title = kind === 'ban' ? known ? t.banTitle({ name }) : t.banSomeoneTitle
    : kind === 'unban' ? t.unbanTitle({ name }) : kind === 'remove' ? t.removeTitle({ name }) : t.addTitle;
  const help = kind === 'ban' ? t.banHelp : kind === 'unban' ? t.unbanHelp : kind === 'remove' ? t.removeHelp : t.addHelp;
  const confirm = kind === 'ban' ? t.banConfirm : kind === 'unban' ? t.unbanConfirm : kind === 'remove' ? t.removeConfirm
    : t.addConfirm;

  async function submit() {
    if (!open) return;
    setError(null); setField(null);
    if ((open.kind === 'add' || open.kind === 'ban' && !open.target) && !who.trim()) { setField('who'); return; }
    if (open.kind === 'add' && !consentPattern.test(consent.trim())) { setField('consent'); return; }
    if (!reason.trim() || reason.trim().length > REASON_LIMIT) { setField('reason'); return; }
    setPending(true);
    let subject = known;
    if (!subject) {
      const found = await api.lookup(who);
      if (!found.ok) { setPending(false); setField('who'); return; }
      onLearn(found.data);
      // Someone already on the roster is changed at their own membership generation.
      const roster = await api.members(found.data.iri, null);
      const row = roster.ok ? roster.data.items.find(item => item.member === found.data.iri) : undefined;
      subject = { iri: found.data.iri, membershipGeneration: row?.membershipGeneration ?? '0', member: row ?? null };
    }
    const seconds = banDurations.find(([label]) => label === duration)?.[1] ?? null;
    const result = await api.changeMember({ actingSubject, expectedGeneration: generation, reason: reason.trim(),
      member: subject.iri, expectedMembershipGeneration: subject.membershipGeneration, action: open.kind,
      consent: open.kind === 'add' ? consent.trim() : null, durationSeconds: open.kind === 'ban' ? seconds : null },
    key.current);
    setPending(false);
    if (!result.ok) {
      setError(failureText(result.failure, t, 'member'));
      if (result.failure === 'stale') key.current = newKey();
      return;
    }
    const shown = nameOf(subject.iri);
    onDone(open.kind === 'ban' ? t.bannedNow({ name: shown }) : open.kind === 'unban' ? t.unbannedNow({ name: shown })
      : open.kind === 'remove' ? t.removedNow({ name: shown }) : t.addedNow({ name: shown }));
  }

  return <CommandDialog open={open !== null} title={title} description={help} confirm={confirm}
    destructive={kind === 'ban' || kind === 'remove'} pending={pending} error={error} cancel={t.cancel}
    onClose={onClose} onConfirm={() => void submit()}
    initialFocus={() => whoRef.current ?? reasonRef.current}>
    {kind === 'add' || kind === 'ban' && !known ? <Field invalid={field === 'who'}>
      <FieldLabel>{t.whoLabel}</FieldLabel>
      <Input ref={whoRef} value={who} placeholder={t.whoPlaceholder} autoComplete="off"
        onChange={event => setWho(event.currentTarget.value)} />
      {field === 'who' ? <FieldError>{t.whoNotFound}</FieldError> : <FieldHelper>{t.whoHelp}</FieldHelper>}
    </Field> : null}
    {kind === 'add' ? <Field invalid={field === 'consent'}>
      <FieldLabel>{t.consentLabel}</FieldLabel>
      <Input value={consent} autoComplete="off" spellCheck={false} onChange={event => setConsent(event.currentTarget.value)} />
      {field === 'consent' ? <FieldError>{t.consentInvalid}</FieldError> : <FieldHelper>{t.consentHelp}</FieldHelper>}
    </Field> : null}
    {kind === 'ban' ? <Field>
      <FieldLabel>{t.durationLabel}</FieldLabel>
      <NativeSelect value={duration} onChange={event => setDuration(event.currentTarget.value)}>
        {banDurations.map(([label]) => <NativeSelectOption key={label} value={label}>{t[label]}</NativeSelectOption>)}
      </NativeSelect>
    </Field> : null}
    <Field invalid={field === 'reason'}>
      <FieldLabel>{kind === 'ban' ? t.banReasonLabel : t.changeReasonLabel}</FieldLabel>
      <Textarea ref={reasonRef} value={reason} rows={3} maxLength={REASON_LIMIT + 200}
        onChange={event => setReason(event.currentTarget.value)} />
      {field === 'reason' ? <FieldError>{reason.trim() ? t.reasonTooLong : t.reasonRequired}</FieldError>
        : <FieldHelper>{kind === 'ban' ? t.banReasonHelp : t.changeReasonHelp}</FieldHelper>}
    </Field>
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
  const { state, save } = useRoleChange(api, { actingSubject, generation, change });
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
        <NativeSelect value={roleId} onChange={event => setRoleId(event.currentTarget.value)} className="w-full">
          {choices.map(role => <NativeSelectOption key={role.id} value={role.id}>{role.name}</NativeSelectOption>)}
        </NativeSelect>
      </Field>
      <Field>
        <FieldLabel>{t.validForLabel}</FieldLabel>
        <NativeSelect value={String(days)} onChange={event => setDays(Number(event.currentTarget.value))} className="w-full">
          {roleDurations.map(([label, value]) => <NativeSelectOption key={label} value={String(value)}>{t[label]}
          </NativeSelectOption>)}
        </NativeSelect>
      </Field>
    </div> : null}
    <ImpactPreview state={state} agents={agents} actingSubject={actingSubject} locale={locale} messages={messages} />
    <Field invalid={error === t.reasonRequired}>
      <FieldLabel>{t.changeReasonLabel}</FieldLabel>
      <Textarea value={reason} rows={2} maxLength={REASON_LIMIT} onChange={event => setReason(event.currentTarget.value)} />
      <FieldHelper>{t.changeReasonHelp}</FieldHelper>
    </Field>
  </CommandDialog>;
}
