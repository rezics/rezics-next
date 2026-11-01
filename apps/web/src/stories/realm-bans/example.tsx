import type { ResolveBanTarget } from '../../community/realm-ban-target';
import { useMemo } from 'react';
import { RealmBansControl } from '../../community/realm-bans-control';
import type { BanReadState, BanWriteInput, BanWriteResult, RealmBanPage } from '../../community/realm-bans';

export const exampleRealmId = '01a1a000-0000-7000-8000-000000000002';
export const exampleAccountId = '01a1a000-0000-7000-8000-000000000081';
const existingAccount = '01a1a000-0000-7000-8000-000000000082';
const laterAccount = '01a1a000-0000-7000-8000-000000000083';
export const fullBanReason =
  'Repeated disruption across several public discussions continued after two moderator notices. The interruptions prevented other members from completing their topics, so this record preserves the complete reason used for the current restriction and its original review context.';
type Scenario =
  | 'current'
  | 'empty'
  | 'loading'
  | 'unavailable'
  | 'forbidden'
  | 'closed'
  | 'invalid-cursor'
  | 'role-required'
  | 'revoked'
  | 'ambiguous'
  | 'saving';

/** DTO-shaped interaction fixtures, not native authorization or workflow completion evidence. */
export function RealmBansExample({ scenario = 'current' }: { scenario?: Scenario }) {
  const boundary = useMemo(() => {
    const existing = {
      accountId: existingAccount,
      reason: fullBanReason,
      actor: null,
      at: '2026-10-31T10:00:00Z',
    };
    let items: RealmBanPage['items'] = scenario === 'current' ? [existing] : [];
    let failed = false;
    const initial: BanReadState = ['loading', 'unavailable', 'forbidden', 'closed', 'invalid-cursor'].includes(scenario)
      ? scenario === 'loading'
        ? { state: 'loading' }
        : scenario === 'forbidden'
          ? { state: 'forbidden' }
          : scenario === 'closed'
            ? { state: 'closed' }
            : scenario === 'invalid-cursor'
              ? { state: 'invalid-cursor' }
              : { state: 'unavailable' }
      : { state: 'ready', page: { items, next: scenario === 'current' ? 'more-bans' : null } };
    return {
      initial,
      resolve: (async (handle) =>
        handle === 'river'
          ? {
              state: 'ready',
              target: {
                lookupHandle: handle,
                account: {
                  id: exampleAccountId,
                  kind: 'actor',
                  state: 'active',
                  handle: 'river',
                  displayName: 'River 林',
                  movedTo: 'river-current',
                  automated: false,
                  operatorId: null,
                },
              },
            }
          : { state: 'missing' }) satisfies ResolveBanTarget,
      read: async (cursor?: string): Promise<BanReadState> => {
        if (scenario === 'forbidden' || scenario === 'revoked') return { state: 'forbidden' };
        if (scenario === 'closed') return { state: 'closed' };
        if (scenario === 'unavailable') return { state: 'unavailable' };
        return {
          state: 'ready',
          page: {
            items: cursor ? [{ ...existing, accountId: laterAccount }] : items,
            next: scenario === 'current' && !cursor ? 'more-bans' : null,
          },
        };
      },
      write: async (input: BanWriteInput): Promise<BanWriteResult> => {
        if (scenario === 'saving') return new Promise(() => {});
        if (scenario === 'role-required') return { ok: false, reason: 'role-required' };
        if (scenario === 'revoked') return { ok: false, reason: 'forbidden' };
        if (scenario === 'ambiguous' && !failed) {
          failed = true;
          throw new Error('Response lost');
        }
        if (input.action === 'unban') {
          items = items.filter((item) => item.accountId !== input.accountId);
          return { ok: true, action: 'unban', accountId: input.accountId };
        }
        const ban = {
          realmId: input.realmId,
          accountId: input.accountId,
          reason: input.reason,
          actor: existingAccount,
          at: existing.at,
          workflowId: 'queued-removal',
        };
        items = [
          ...items.filter((item) => item.accountId !== input.accountId),
          {
            accountId: ban.accountId,
            reason: ban.reason,
            actor: ban.actor,
            at: ban.at,
          },
        ];
        return { ok: true, action: 'ban', ban };
      },
    };
  }, [scenario]);
  return (
    <RealmBansControl
      key={scenario}
      realmId={exampleRealmId}
      initial={boundary.initial}
      read={boundary.read}
      write={boundary.write}
      resolve={boundary.resolve}
      ready
    />
  );
}
