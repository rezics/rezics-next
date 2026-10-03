import type { Pool } from 'pg';
import { randomInt } from 'node:crypto';
import { asciiHandleSuggestion, normalizeAddressAlias } from '@rezics/model/address/aliases';
import {
  ALIAS_COST,
  AliasRegistry,
  AliasInvalid,
  AliasUnavailable,
  type AliasRow,
} from '../address/registry.ts';
export { AliasInvalid as VanityInvalid } from '../address/registry.ts';
import { agentForHandle } from './handle.ts';

export const VANITY_HANDLE_PATTERN = '^[a-z0-9](?:[a-z0-9_-]{1,28})[a-z0-9]$';
export const HANDLE_COOLDOWN_DAYS = 30;
export const VANITY_SUGGESTION_COST = {
  sequentialCandidates: 256,
  candidates: 320,
  availabilityQueries: 5,
} as const;
export function normalizeVanity(value: string): string {
  try {
    const key = normalizeAddressAlias(value, 'ascii-handle').key;
    return key;
  } catch (error) {
    throw new AliasInvalid(error instanceof Error ? error.message : 'Invalid handle');
  }
}
export function suggestVanity(displayName: string): string {
  return asciiHandleSuggestion(displayName) ?? 'reader';
}
export interface HandleResolution {
  agent: string;
  handle: string;
  currentHandle: string;
  state: 'current' | 'retired' | 'native';
  redirect: boolean;
}
/** Profile hydration adapter, not a second naming store or write capability. */
export class AgentVanityHandles {
  private readonly aliases: AliasRegistry;
  constructor(pool: Pool) {
    this.aliases = new AliasRegistry(pool);
  }
  /** Advisory only: a claim still checks availability atomically. At most five
   * indexed batches probe reserved, retained and cross-Space confusable aliases;
   * a final random numeric range avoids capping a common name at 256 holders.
   * No registry inventory scan or identity-based fallback is permitted. */
  async suggest(displayName: string): Promise<string> {
    const base = suggestVanity(displayName);
    return this.aliases.withRead(async () => {
      for (let offset = 0; offset < VANITY_SUGGESTION_COST.candidates; offset += ALIAS_COST.batch) {
        const start =
          offset < VANITY_SUGGESTION_COST.sequentialCandidates
            ? offset + 1
            : randomInt(
                VANITY_SUGGESTION_COST.sequentialCandidates + 1,
                1_000_000_000 - ALIAS_COST.batch,
              );
        const candidates = Array.from({ length: ALIAS_COST.batch }, (_, index) => {
          const ordinal = start + index;
          if (ordinal === 1) return base;
          const suffix = String(ordinal);
          return base.slice(0, 30 - suffix.length).replace(/[_-]+$/g, '') + suffix;
        });
        const available = await this.aliases.firstAvailable('agent', candidates);
        if (available) return available;
      }
      throw new AliasUnavailable('No readable handle suggestion within the candidate budget');
    });
  }
  async current(agent: string): Promise<string | null> {
    return (await this.currents([agent])).get(agent) ?? null;
  }
  async currents(agents: readonly string[]): Promise<Map<string, string>> {
    if (!agents.length) return new Map();
    const rows = await this.aliases.pool.query<Pick<AliasRow, 'holder' | 'key'>>(
      `SELECT holder,key FROM access.alias_registry
      WHERE scope = 'agent' AND state = 'current' AND holder = ANY($1::text[])`,
      [agents],
    );
    return new Map(rows.rows.map((row) => [row.holder, row.key]));
  }
  async resolve(input: string): Promise<HandleResolution | null> {
    const native = agentForHandle(input);
    if (native) {
      const name = await this.current(native);
      return {
        agent: native,
        handle: input,
        currentHandle: name ?? input,
        state: 'native',
        redirect: name !== null,
      };
    }
    let key;
    try {
      key = normalizeAddressAlias(input, 'ascii-handle').key;
    } catch {
      return null;
    }
    const row = await this.aliases.lookup('agent', key);
    if (!row || row.state === 'retired') return null;
    return {
      agent: row.holder,
      handle: key,
      currentHandle: (await this.current(row.holder)) ?? row.holder.slice(-36),
      state: row.state === 'current' ? 'current' : 'retired',
      redirect: row.state !== 'current' || input !== key,
    };
  }
}
