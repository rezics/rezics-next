import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError } from '../../kernel/platform-closed';
import { parseSettingsSnapshot, type SettingsRead } from './settings';

function continuity(headers?: HeadersInit): { session?: string } {
  const session = new Headers(headers).get('rezics-session-token');
  return session ? { session } : {};
}

function failure(status: number, headers?: HeadersInit): Exclude<SettingsRead, { kind: 'ready' | 'loading' }> {
  const next = continuity(headers);
  if (status === 401 || status === 403) return { kind: 'denied', ...next };
  return { kind: 'unavailable', ...next };
}

/** Active or exact immutable release, through generated methods and the current caller. */
export async function readSettingsInventory(
  client: KernelClient,
  authorization: string,
  digest?: string,
  session?: string,
): Promise<SettingsRead> {
  const headers: Record<string, string> = {
    authorization,
    ...(session ? { 'rezics-session-token': session } : {}),
  };
  try {
    let selected = digest;
    if (!selected) {
      const active = await client.definitions.active.get({ headers });
      if (active.status !== 200 || typeof active.data?.digest !== 'string' || !active.data.digest)
        return failure(active.status, active.headers);
      selected = active.data.digest;
    }
    const released = await client.definitions.releases({ digest: selected }).get({ headers });
    if (released.status !== 200 || !released.data) return failure(released.status, released.headers);
    if (released.data.digest !== selected) return { kind: 'unavailable', ...continuity(released.headers) };
    const snapshot = parseSettingsSnapshot(selected, released.data.release);
    return snapshot
      ? { kind: 'ready', snapshot, ...continuity(released.headers) }
      : { kind: 'unavailable', ...continuity(released.headers) };
  } catch (error) {
    return { kind: isPlatformClosedError(error) ? 'denied' : 'unavailable' };
  }
}

export function settingsDigest(input: Record<string, unknown>): { digest?: string; session?: string } {
  if (input.digest !== undefined) {
    if (typeof input.digest !== 'string' || !input.digest || input.digest.length > 256)
      throw new Error('Invalid release digest');
  }
  if (input.session !== undefined && (typeof input.session !== 'string' || input.session.length > 16384))
    throw new Error('Invalid continuity');
  return {
    ...(typeof input.digest === 'string' ? { digest: input.digest } : {}),
    ...(typeof input.session === 'string' ? { session: input.session } : {}),
  };
}
