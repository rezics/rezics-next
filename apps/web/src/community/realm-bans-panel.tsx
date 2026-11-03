import { useContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { useSession } from '../session/query';
import { changeRealmBan, readRealmBans, resolveRealmBanTarget } from './space-actions';
import { getLocale } from '../paraglide/runtime.js';
import { CommunityManagementContext } from './community-management';
import { RealmBansControl } from './realm-bans-control';
import { RealmBanLifetime, realmBanSessionSource } from './realm-ban-lifetime';
import type { BanReadState, BanWriteInput, BanWriteResult } from './realm-bans';
import type { ResolveBanTarget } from './realm-ban-target';
import { SelectedRealmMemberContext } from './members/selected-account';

const subscribe = () => () => {};
const serverRevision = () => 0;
const serverCurrent = () => false;

/** The page supplies only the Realm anchor. Native list and commands decide current authority. */
export function RealmBansPanel({ realmId }: { realmId: string }) {
  const { state, csrfToken, subject } = useSession();
  const client = useContext(QueryClientContext);
  const region = useContext(CommunityManagementContext);
  const selectedMember = useContext(SelectedRealmMemberContext);
  const entered = useRef(false);
  if (region?.entered) entered.current = true;
  // Keep the original positive admission read before entry; a later close retires the visit.
  const exposed = !entered.current || region?.entered !== false;
  const source = client && typeof window !== 'undefined' ? realmBanSessionSource(client) : undefined;
  const revision = useSyncExternalStore(
    source?.subscribe ?? subscribe,
    source?.snapshot ?? serverRevision,
    serverRevision,
  );
  const selectedCurrent = useSyncExternalStore(
    selectedMember?.subscribe ?? subscribe,
    selectedMember?.current ?? serverCurrent,
    serverCurrent,
  );
  const locale = getLocale();
  const binding = useMemo(() => {
    const observe = (listener: () => void) => {
      const stopSession = source?.subscribe(listener);
      const stopMember = selectedMember?.subscribe(listener);
      return () => {
        stopSession?.();
        stopMember?.();
      };
    };
    const lifetime = new RealmBanLifetime(() => {
      const session = source?.read();
      return (
        exposed &&
        getLocale() === locale &&
        !!source &&
        source.snapshot() === revision &&
        state === 'signed-in' &&
        !!subject &&
        !!csrfToken &&
        session?.state === state &&
        session.subject === subject &&
        session.csrfToken === csrfToken &&
        (!selectedMember || selectedMember.current())
      );
    }, observe);
    return {
      lifetime,
      read: async (cursor?: string): Promise<BanReadState> => {
        if (!lifetime.current()) return { state: 'signed-out' };
        const ticket = lifetime.ticket();
        const next = await readRealmBans({ data: { realmId, ...(cursor ? { cursor } : {}) } });
        return lifetime.owns(ticket) ? next : { state: 'signed-out' };
      },
      write: async (input: BanWriteInput): Promise<BanWriteResult> => {
        if (!lifetime.current() || !csrfToken || input.realmId !== realmId) return { ok: false, reason: 'signed-out' };
        const ticket = lifetime.ticket();
        const next = await changeRealmBan({ data: input, headers: { 'X-CSRF-Token': csrfToken } });
        return lifetime.owns(ticket) ? next : { ok: false, reason: 'signed-out' };
      },
      resolve: (async (handle, signal) => {
        if (!lifetime.current() || signal.aborted) return { state: 'signed-out' };
        const ticket = lifetime.ticket();
        const next = await resolveRealmBanTarget({ data: handle, signal });
        return lifetime.owns(ticket) && !signal.aborted ? next : { state: 'signed-out' };
      }) satisfies ResolveBanTarget,
    };
  }, [realmId, source, selectedMember, selectedCurrent, revision, state, subject, csrfToken, locale, exposed]);
  const previous = useRef(binding);
  if (previous.current !== binding) {
    previous.current.lifetime.retire();
    previous.current = binding;
  }
  useLayoutEffect(() => binding.lifetime.connect(), [binding]);
  if (state !== 'signed-in' || !subject || !exposed || (selectedMember && !selectedCurrent)) return null;
  return (
    <RealmBansControl
      key={`${realmId}:${subject}`}
      realmId={realmId}
      {...binding}
      {...(selectedMember ? { selectedMember } : {})}
      ready={!!csrfToken}
    />
  );
}
