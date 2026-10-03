import type { AliasPolicy } from '@rezics/model/address/aliases';
export interface ScopePolicy {
  characters: AliasPolicy;
  canonical: 'alias' | 'id';
  cooldown_days: number;
}
export const ALIAS_POLICIES = {
  agent: { characters: 'ascii-handle', canonical: 'alias', cooldown_days: 30 },
  space: { characters: 'ascii-handle', canonical: 'alias', cooldown_days: 0 },
  work: { characters: 'unicode-title', canonical: 'alias', cooldown_days: 0 },
  zone: { characters: 'unicode-title', canonical: 'alias', cooldown_days: 0 },
} as const satisfies Record<string, ScopePolicy>;
