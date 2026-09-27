'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { browserMainApi } from '../api/browser.ts';
import { changeMember, changeRole, newKey, type Outcome, previewRole, saveSettings } from './commands.ts';
import type { ImpactState } from './impact-preview.tsx';
import { mergeAgents, readAgents, readHandle, readMembers, readRoles, readSettings } from './read.ts';
import type { AgentSummary, Loaded, MemberCommand, MemberPage, MemberReceipt, RoleChange, RoleCommand, RoleImpact,
  RoleList, RoleReceipt, SettingsReceipt, SettingsView } from './types.ts';

/** Members, roles and settings from the browser. Stories pass a stand-in. */
export interface AdminApi {
  members(search: string, after: string | null): Promise<Loaded<MemberPage>>;
  names(iris: readonly string[]): Promise<Record<string, AgentSummary>>;
  lookup(handle: string): Promise<Loaded<AgentSummary>>;
  changeMember(command: MemberCommand, key: string): Promise<Outcome<MemberReceipt>>;
  roles(): Promise<Loaded<RoleList>>;
  preview(command: RoleCommand): Promise<Outcome<RoleImpact>>;
  changeRole(command: RoleCommand, digest: string, key: string): Promise<Outcome<RoleReceipt>>;
  settings(): Promise<Loaded<SettingsView>>;
  saveSettings(command: Parameters<typeof saveSettings>[2], key: string): Promise<Outcome<SettingsReceipt>>;
}

export function bffAdminApi(realm: string, actingSubject: string): AdminApi {
  const main = () => browserMainApi();
  return {
    members: (search, after) => readMembers(main(), realm, { actingSubject, search, after }),
    names: iris => readAgents(main(), iris, actingSubject),
    lookup: handle => readHandle(main(), handle, actingSubject),
    changeMember: (command, key) => changeMember(main(), realm, command, key),
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

export type RoleSave = Outcome<RoleReceipt> | { ok: false; failure: 'changed'; impact: RoleImpact };

/**
 * A role change's live impact preview and its save. The preview follows the
 * change (debounced); a Realm generation that moved under it is read again
 * once and the refreshed preview says so.
 */
export function useRoleChange(api: AdminApi, input: { actingSubject: string; generation: string;
  change: RoleChange | null }) {
  const [state, setState] = useState<ImpactState>({ kind: 'idle' });
  // People a change affects need not be on the roster the page already named.
  const [names, setNames] = useState<Record<string, AgentSummary>>({});
  const generation = useRef(input.generation);
  const request = JSON.stringify(input.change);
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
  }, [request, preview, api]);

  const save = useCallback(async (reason: string): Promise<RoleSave> => {
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
    return api.changeRole(command, bound.data.digest, newKey());
  }, [api, preview, request, input.actingSubject]);

  return { state, save, names };
}
