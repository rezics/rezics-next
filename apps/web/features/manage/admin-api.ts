'use client';

import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { browserMainApi } from '../api/browser.ts';
import { changeMember, changeRole, invite, newKey, type Outcome, previewRole, saveSettings, send } from './commands.ts';
import type { ImpactState } from './impact-preview.tsx';
import { attemptStorage, performCommand, readCommand, retainedCommands } from './safety-pending.ts';
import { mergeAgents, readAgents, readHandle, readMembers, readOutgoingInvitations, readRoles, readSettings } from './read.ts';
import type { AgentSummary, InvitationCommand, InvitationPage, InvitationResult, Loaded, MainClient, MemberCommand, MemberPage, MemberReceipt,
  RoleChange, RoleCommand, RoleImpact, RoleList, RoleReceipt, SettingsReceipt, SettingsView } from './types.ts';

/** Members, roles and settings from the browser. Stories pass a stand-in. */
export interface AdminApi {
  /** Principal supplied by an injected adapter; normal pages pass the authenticated server value. */
  principal?: string;
  members(search: string, after: string | null, role?: string | null): Promise<Loaded<MemberPage>>;
  names(iris: readonly string[]): Promise<Record<string, AgentSummary>>;
  lookup(handle: string): Promise<Loaded<AgentSummary>>;
  changeMember(command: MemberCommand, key: string): Promise<Outcome<MemberReceipt>>;
  invite(command: InvitationCommand, key: string): Promise<Outcome<InvitationResult>>;
  invitations(after: string | null): Promise<Loaded<InvitationPage>>;
  revoke(invitation: string, key: string): Promise<Outcome<InvitationResult>>;
  roles(): Promise<Loaded<RoleList>>;
  preview(command: RoleCommand): Promise<Outcome<RoleImpact>>;
  changeRole(command: RoleCommand, digest: string, key: string): Promise<Outcome<RoleReceipt>>;
  settings(): Promise<Loaded<SettingsView>>;
  saveSettings(command: Parameters<typeof saveSettings>[2], key: string): Promise<Outcome<SettingsReceipt>>;
}

export function bffAdminApi(realm: string, actingSubject: string): AdminApi {
  return adminApi(() => browserMainApi(), realm, actingSubject);
}

/** The same browser adapter with a supplied typed transport for recorded paths. */
export function adminApi(main: () => MainClient, realm: string, actingSubject: string): AdminApi {
  return {
    members: (search, after, role) => readMembers(main(), realm, { actingSubject, search, after, role }),
    names: iris => readAgents(main(), iris, actingSubject),
    lookup: handle => readHandle(main(), handle, actingSubject),
    changeMember: (command, key) => changeMember(main(), realm, command, key),
    invite: (command, key) => invite(main(), realm, command, key),
    invitations: after => readOutgoingInvitations(main(), realm, actingSubject, after),
    revoke: (invitation, key) => send(() => main().v1.realms({ realm }).invitations({ invitation }).revoke.post(
      { actingSubject }, { headers: { 'idempotency-key': key } })),
    roles: () => readRoles(main(), realm, actingSubject),
    preview: command => previewRole(main(), realm, command),
    changeRole: (command, digest, key) => changeRole(main(), realm, command, digest, key),
    settings: () => readSettings(main(), realm, actingSubject),
    saveSettings: (command, key) => saveSettings(main(), realm, command, key),
  };
}

// Main requires a reason on every role command and binds its impact digest to
// the whole command. The preview runs before the reason is written, with this
// stand-in; saving previews again with the real reason and goes ahead only if
// the people affected and how are exactly what was shown.
const PREVIEW_REASON = 'Preview';
const sameImpact = (a: RoleImpact, b: RoleImpact) => JSON.stringify(a.changes) === JSON.stringify(b.changes);

export type RoleSave = Outcome<RoleReceipt> & { unconfirmed?: boolean; command?: RoleCommand }
  | { ok: false; failure: 'changed'; impact: RoleImpact };
type RoleRequest = { command: RoleCommand; digest: string; impact?: RoleImpact };

/** Role writes remain reachable after their dialog closes, including a newly created role. */
export function useRoleRecovery(api: AdminApi, realm: string, actor: string, editing: boolean, principal: string) {
  const store = useMemo(() => attemptStorage(principal), [principal]);
  const [attempts, setAttempts] = useState<ReturnType<typeof retainedCommands<RoleRequest>>>([]);
  const [pending, setPending] = useState(false);
  useEffect(() => { if (!editing) setAttempts(retainedCommands<RoleRequest>(realm, actor, 'role', store)); }, [realm, actor, editing, store]);
  const resume = async (operation: string): Promise<RoleSave> => {
    const attempt = readCommand<RoleRequest>(realm, actor, operation, store);
    if (!attempt || pending) return { ok: false, failure: 'unavailable' };
    setPending(true);
    const result = await performCommand(operation, attempt,
      stored => api.changeRole(stored.input.command, stored.input.digest, stored.key), store);
    setAttempts(retainedCommands<RoleRequest>(realm, actor, 'role', store));
    setPending(false);
    return result.ok ? result : { ...result, unconfirmed: readCommand(realm, actor, operation, store) !== null };
  };
  return { attempts: editing ? [] : attempts.filter(entry => entry.attempt.principal === principal
    && entry.attempt.realm === realm && entry.attempt.actingSubject === actor), pending, resume };
}

/**
 * A role change's live impact preview and its save. The preview follows the
 * change (debounced); a Realm generation that moved under it is read again
 * once and the refreshed preview says so.
 */
export function useRoleChange(api: AdminApi, input: { principal: string; realm: string; actingSubject: string; generation: string;
  change: RoleChange | null }) {
  const store = useMemo(() => attemptStorage(input.principal), [input.principal]);
  const [preparation, restartPreparation] = useState(0);
  const [state, setState] = useState<ImpactState>({ kind: 'idle' });
  // People a change affects need not be on the roster the page already named.
  const [names, setNames] = useState<Record<string, AgentSummary>>({});
  const generation = useRef(input.generation);
  const request = JSON.stringify(input.change);
  const operation = input.change ? `role:${input.change.kind}:${input.change.roleId}${input.change.kind === 'assignment'
    ? `:${input.change.member}` : ''}` : 'role';
  const [recovering, setRecovering] = useState(() => readCommand<RoleRequest>(input.realm, input.actingSubject, operation, store) !== null);
  const shown = useRef<RoleImpact | null>(null);
  useEffect(() => { generation.current = input.generation; }, [input.generation]);

  const preview = useCallback(async (change: RoleChange, reason: string): Promise<Outcome<RoleImpact>> => {
    const command = (): RoleCommand => ({ actingSubject: input.actingSubject, expectedGeneration: generation.current,
      reason, change });
    let result = await api.preview(command());
    if (!result.ok && result.failure === 'stale') {
      const roles = await api.roles();
      if (roles.ok) { generation.current = roles.data.generation; result = await api.preview(command()); }
    }
    return result;
  }, [api, input.actingSubject]);

  useEffect(() => {
    const retained = readCommand<RoleRequest>(input.realm, input.actingSubject, operation, store);
    if (retained) {
      setRecovering(true);
      setState(retained.input.impact ? { kind: 'ready', impact: retained.input.impact, refreshed: false } : { kind: 'failed' });
      return;
    }
    setRecovering(false);
    const change = request === 'null' ? null : JSON.parse(request) as RoleChange;
    if (!change) { setState({ kind: 'idle' }); shown.current = null; return; }
    let current = true;
    setState({ kind: 'checking' });
    const timer = setTimeout(() => {
      const before = generation.current;
      void preview(change, PREVIEW_REASON).then(result => {
        if (!current) return;
        shown.current = result.ok ? result.data : null;
        setState(result.ok ? { kind: 'ready', impact: result.data, refreshed: before !== generation.current }
          : { kind: 'failed' });
        if (result.ok && result.data.changes.length) {
          void api.names(result.data.changes.map(change => change.member))
            .then(found => { if (current) setNames(known => mergeAgents(known, found)); });
        }
      });
    }, 350);
    return () => { current = false; clearTimeout(timer); };
  }, [request, preview, api, input.realm, input.actingSubject, operation, store, preparation]);

  const save = useCallback(async (reason: string): Promise<RoleSave> => {
    const retained = readCommand<RoleRequest>(input.realm, input.actingSubject, operation, store);
    if (retained) {
      let committed = retained.input.command;
      const result = await performCommand(operation, retained, attempt => {
        committed = attempt.input.command;
        return api.changeRole(attempt.input.command, attempt.input.digest, attempt.key);
      }, store);
      const unconfirmed = !result.ok && readCommand(input.realm, input.actingSubject, operation, store) !== null;
      setRecovering(unconfirmed);
      if (!result.ok && !unconfirmed) {
        shown.current = null;
        setState({ kind: 'checking' });
        restartPreparation(value => value + 1);
      }
      return result.ok ? { ...result, command: committed } : { ...result, unconfirmed };
    }
    const change = request === 'null' ? null : JSON.parse(request) as RoleChange;
    if (!change || !shown.current) return { ok: false, failure: 'invalid' };
    const bound = await preview(change, reason.trim());
    if (!bound.ok) return bound;
    if (!sameImpact(bound.data, shown.current)) {
      shown.current = bound.data;
      setState({ kind: 'ready', impact: bound.data, refreshed: true });
      return { ok: false, failure: 'changed', impact: bound.data };
    }
    const command: RoleCommand = { actingSubject: input.actingSubject, expectedGeneration: generation.current,
      reason: reason.trim(), change };
    let committed = command;
    const result = await performCommand(operation, { realm: input.realm, actingSubject: input.actingSubject,
      input: { command, digest: bound.data.digest, impact: bound.data }, key: newKey(), status: 'recorded' },
      attempt => { committed = attempt.input.command; return api.changeRole(attempt.input.command, attempt.input.digest, attempt.key); }, store);
    const unconfirmed = !result.ok && readCommand(input.realm, input.actingSubject, operation, store) !== null;
    setRecovering(unconfirmed);
    if (!result.ok && !unconfirmed) {
      shown.current = null;
      setState({ kind: 'checking' });
      restartPreparation(value => value + 1);
    }
    return result.ok ? { ...result, command: committed } : { ...result, unconfirmed };
  }, [api, preview, request, input.actingSubject, input.realm, operation, store]);

  const retained = readCommand<RoleRequest>(input.realm, input.actingSubject, operation, store);
  return { state, save, names, recovering, recoveredCommand: retained?.input.command ?? null };
}
