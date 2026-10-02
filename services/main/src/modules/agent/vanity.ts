import type { Pool } from 'pg';
import { normalizeAddressName } from '@rezics/model/address/names';
import { NameRegistry,NameInvalid, type NameRow } from '../address/registry.ts';
export { NameInvalid as VanityInvalid } from '../address/registry.ts';
import { agentForHandle } from './handle.ts';

export const VANITY_HANDLE_PATTERN = '^[a-z0-9](?:[a-z0-9_-]{1,28})[a-z0-9]$';
export const HANDLE_COOLDOWN_DAYS = 30;
export function normalizeVanity(value: string): string {
  try {
    const key = normalizeAddressName(value,'ascii-handle').key;
    return key;
  } catch (error) { throw new NameInvalid(error instanceof Error ? error.message : 'Invalid handle'); }
}
export function suggestVanity(displayName: string): string {
  const base = displayName.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g,'_')
    .replace(/^_+|_+$/g,'').slice(0,30).replace(/_+$/g,'');
  return base.length >= 3 ? base : 'reader';
}
export interface HandleResolution { agent: string; handle: string; currentHandle: string;
  state: 'current' | 'retired' | 'native'; redirect: boolean }
/** Profile hydration adapter, not a second naming store or write capability. */
export class AgentVanityHandles {
  private readonly names: NameRegistry;
  constructor(pool: Pool) { this.names = new NameRegistry(pool); }
  async current(agent: string): Promise<string | null> { return (await this.currents([agent])).get(agent) ?? null; }
  async currents(agents: readonly string[]): Promise<Map<string,string>> {
    if (!agents.length) return new Map();
    const rows = await this.names.pool.query<Pick<NameRow,'holder' | 'key'>>(`SELECT holder,key FROM access.name_registry
      WHERE scope = 'agent' AND state = 'current' AND holder = ANY($1::text[])`, [agents]);
    return new Map(rows.rows.map(row => [row.holder,row.key]));
  }
  async resolve(input: string): Promise<HandleResolution | null> {
    const native = agentForHandle(input);
    if (native) {
      const name = await this.current(native);
      return { agent: native,handle: input,currentHandle: name ?? input,state: 'native',redirect: name !== null };
    }
    let key;
    try { key = normalizeAddressName(input,'ascii-handle').key; } catch { return null; }
    const row = await this.names.lookup('agent',key);
    if (!row || row.state === 'retired') return null;
    return { agent: row.holder,handle: key,currentHandle: await this.current(row.holder) ?? row.holder.slice(-36),
      state: row.state === 'current' ? 'current' : 'retired',redirect: row.state !== 'current' || input !== key };
  }
}
