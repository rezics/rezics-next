import type { NamePolicy } from '@rezics/model/address/names';
export interface ScopePolicy {
  characters: NamePolicy;
  canonical: 'name' | 'id';
  cooldown_days: number;
}
export const NAME_POLICIES = {
  agent: { characters: 'ascii-handle', canonical: 'name', cooldown_days: 30 },
  space: { characters: 'ascii-handle', canonical: 'name', cooldown_days: 0 },
  work: { characters: 'unicode-title', canonical: 'name', cooldown_days: 0 },
  zone: { characters: 'unicode-title', canonical: 'name', cooldown_days: 0 },
} as const satisfies Record<string, ScopePolicy>;
