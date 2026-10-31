import { systemClock, type KernelClock } from '../clock.ts';
import type { AccessClient } from '../request/access.ts';
import { normalizeHandle } from './lifecycle.ts';
import read from './handle-holder.sql';
import { createHash } from 'node:crypto';

function handleRoute(normalized: string): number {
  return createHash('sha256').update(normalized).digest().readUInt16BE(0);
}

/** Read the effective owner of one active or unexpired reserved account handle. */
export async function handleHolder(
  client: AccessClient,
  normalized: string,
  clock: KernelClock = systemClock,
): Promise<Readonly<{ accountId: string; state: 'active' | 'reserved' }> | null> {
  if (normalizeHandle(normalized) !== normalized) throw new TypeError('A normalized handle is required');
  const row = await read.run(client, { route: handleRoute(normalized), handle: normalized, at: clock().toISOString() });
  if (!row || row.accountId === null || (row.state !== 'active' && row.state !== 'reserved')) return null;
  return { accountId: row.accountId, state: row.state };
}
