import { identityKeyUuid, uuidToSid } from '@rezics/model/address';

const iriPattern = /^https:\/\/rezics\.com\/id\/([0-9a-f-]{36})$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const handlePattern = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9])?$/;

export interface MaintainerName {
  displayName: string;
  handle: string | null;
}

export interface MaintainerRow {
  id: string;
  name: string;
  handle: string | null;
  owner: boolean;
  /** The owner may remove this person: not themselves, and not the last maintainer. */
  remove: boolean;
}

/**
 * Remove belongs to the owner, and never to the owner's own row. A Work always
 * keeps its last maintainer, so a list of one has no Remove.
 */
export function showRemove(viewer: string, owner: string, target: string, count: number): boolean {
  return count > 1 && viewer === owner && target !== owner;
}

/** Any current maintainer may add another. */
export function showAdd(viewer: string, maintainers: readonly string[]): boolean {
  return maintainers.includes(viewer);
}

export function maintainerLabel(id: string, name: MaintainerName | undefined): string {
  const display = name?.displayName.trim();
  if (display) return display;
  if (name?.handle) return `@${name.handle}`;
  const uuid = id.slice(-36);
  try { return uuidToSid(uuid); } catch { return uuid; }
}

/** Owner first, then everyone else in the order the list was read. */
export function maintainerRows(input: {
  viewer: string;
  owner: string;
  maintainers: readonly string[];
  names: Readonly<Record<string, MaintainerName | undefined>>;
}): MaintainerRow[] {
  const ids = input.maintainers.includes(input.owner)
    ? [input.owner, ...input.maintainers.filter(id => id !== input.owner)]
    : [...input.maintainers];
  return ids.map(id => {
    const name = input.names[id];
    return {
      id, name: maintainerLabel(id, name), handle: name?.handle ?? null, owner: id === input.owner,
      remove: showRemove(input.viewer, input.owner, id, input.maintainers.length),
    };
  });
}

export type MaintainerTarget =
  | { kind: 'iri'; iri: string }
  | { kind: 'handle'; handle: string }
  | { kind: 'invalid' };

/** A handle (`@lin_mei` or `lin_mei`), or an identity address (IRI, UUID or sid). */
export function maintainerTarget(raw: string): MaintainerTarget {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 80) return { kind: 'invalid' };
  const forcedHandle = trimmed.startsWith('@');
  const value = forcedHandle ? trimmed.slice(1) : trimmed;
  if (!value) return { kind: 'invalid' };
  if (!forcedHandle) {
    const written = iriPattern.exec(value);
    if (written?.[1]) return { kind: 'iri', iri: `https://rezics.com/id/${written[1]}` };
    if (uuidPattern.test(value)) return { kind: 'iri', iri: `https://rezics.com/id/${value.toLowerCase()}` };
    const sid = value.length === 22 || (value.length > 22 && value[22] === '-') ? identityKeyUuid(value) : null;
    if (sid) return { kind: 'iri', iri: `https://rezics.com/id/${sid}` };
  }
  return handlePattern.test(value) ? { kind: 'handle', handle: value } : { kind: 'invalid' };
}

/**
 * What a maintainer write's HTTP answer means for the person.
 * A generation conflict is answered as `idempotency_conflict` (the same intent
 * with the same key replays as 200). Any other 409 is a list that moved or a
 * refusal reloading the list makes visible, so it follows the stale path:
 * keep what was typed and offer Reload latest. `controller_continuity` is the
 * last-maintainer refusal, which reloading does not change.
 */
export type MaintainerProblem = 'sign-in' | 'denied' | 'stale' | 'continuity' | 'invalid' | 'unavailable';

export function maintainerProblem(status: number, code: string | null): MaintainerProblem {
  if (status === 401) return 'sign-in';
  if (status === 403 || status === 404) return 'denied';
  if (status === 409 && code === 'controller_continuity') return 'continuity';
  if (status === 409) return 'stale';
  if (status === 400 || status === 422) return 'invalid';
  return 'unavailable';
}

/** Titles Main uses for every maintainer refusal of that class. The panel says the class in its own words. */
const genericTitles = new Set([
  'Idempotency key conflicts with an earlier request',
  'This change would leave a resource without a controller',
  'Authority is not admitted',
  'Work operation could not be completed',
]);

export function maintainerDetail(title: string | null): string | null {
  return title && !genericTitles.has(title) ? title : null;
}

/** The same change against the same generation replays; a moved list is a different key. */
export async function maintainerChangeKey(parts: readonly string[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)));
  const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `maintainer:${hex.slice(0, 48)}`;
}
