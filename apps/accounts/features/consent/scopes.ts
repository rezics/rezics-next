import type messages from './messages/en.ts';

export type ScopeGroup = 'identity' | 'works' | 'other' | 'offline';
type ScopeMessage = Extract<keyof typeof messages, `scope${string}`>;

// Plain-language descriptions of scopes a person is asked to grant. A scope
// without one is still shown, verbatim, under "Other access".
const described: Record<string, { group: ScopeGroup; message: ScopeMessage }> = {
  openid: { group: 'identity', message: 'scopeOpenid' },
  profile: { group: 'identity', message: 'scopeProfile' },
  email: { group: 'identity', message: 'scopeEmail' },
  'work:read': { group: 'works', message: 'scopeWorkRead' },
  'work:create': { group: 'works', message: 'scopeWorkCreate' },
  'work:edit': { group: 'works', message: 'scopeWorkEdit' },
  offline_access: { group: 'offline', message: 'scopeOfflineAccess' },
};
const order: ScopeGroup[] = ['identity', 'works', 'other', 'offline'];

export interface ScopeLine { scope: string; message?: ScopeMessage }

export function groupScopes(scopes: readonly string[]): { group: ScopeGroup; lines: ScopeLine[] }[] {
  const groups = new Map<ScopeGroup, ScopeLine[]>();
  for (const scope of new Set(scopes)) {
    const known = described[scope];
    const group = known?.group ?? 'other';
    groups.set(group, [...groups.get(group) ?? [], { scope, message: known?.message }]);
  }
  return order.filter(group => groups.has(group)).map(group => ({ group, lines: groups.get(group)! }));
}
