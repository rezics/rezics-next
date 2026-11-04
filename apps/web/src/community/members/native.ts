import type { KernelClient } from '@rezics/client';

/** Minimal public wire seam for community/routes.ts, pending the shared declaration publication. */
export type RealmMembersReadInput = {
  realmId: string;
  viewerId: string;
  cursor?: string | undefined;
  accountId?: string | undefined;
};
type Identity = { id: string; kind: 'actor' | 'organization' } & (
  | { state: 'deleted' }
  | { state: 'active'; handle: string | null; displayName: string | null }
);
type Action =
  | {
      state: 'available';
      method: 'POST' | 'PUT' | 'DELETE';
      path: string;
      body: { accountId: string } | { reason: string } | null;
      expectedStatus: 202 | 200 | 204;
      outcome: string;
    }
  | { state: 'prohibited'; reason: string }
  | { state: 'uncertain'; reason: 'authority_unavailable' | 'identity_unavailable' }
  | { state: 'unavailable'; reason: 'no_mounted_method' };
export type NativeRealmMember = {
  accountId: string;
  episode: string;
  membership: 'member' | 'none';
  identity: Identity | null;
  displayName: string;
  banState: 'banned' | 'clear' | 'unknown';
  actions: Record<'addMember' | 'ban' | 'unban' | 'removeMember' | 'reviseRole', Action>;
};
export type NativeRealmMembersPage = {
  realmId: string;
  state: 'ready' | 'preparing';
  items: NativeRealmMember[];
  next: string | null;
  selected: NativeRealmMember | null;
};
export type NativeRealmMembersRead =
  | { kind: 'ready'; page: NativeRealmMembersPage }
  | { kind: 'preparing' | 'denied' | 'concealed' | 'expired' | 'unavailable' | 'failed' };

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
const keys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).every((key) => allowed.includes(key)) && allowed.every((key) => key in v);
const nullableText = (v: unknown, max: number) => v === null || text(v, max);

export function validateRealmMembersRead(input: unknown): RealmMembersReadInput {
  if (
    !record(input) ||
    !id(input.realmId) ||
    !id(input.viewerId) ||
    (input.cursor !== undefined && !text(input.cursor, 4096)) ||
    (input.accountId !== undefined && !id(input.accountId))
  )
    throw new Error('Invalid Realm member read');
  return {
    realmId: input.realmId,
    viewerId: input.viewerId,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor as string }),
    ...(input.accountId === undefined ? {} : { accountId: input.accountId as string }),
  };
}

function identity(value: unknown, accountId: string): boolean {
  if (value === null) return true;
  if (!record(value) || value.id !== accountId || !['actor', 'organization'].includes(String(value.kind))) return false;
  return value.state === 'deleted'
    ? keys(value, ['id', 'kind', 'state'])
    : value.state === 'active' &&
        keys(value, ['id', 'kind', 'state', 'handle', 'displayName']) &&
        nullableText(value.handle, 64) &&
        nullableText(value.displayName, 4096);
}

const prohibitedReasons = [
  'already_member',
  'already_banned',
  'not_banned',
  'not_authorized',
  'protected_owner_or_moderator',
  'deleted_account',
  'identity_unavailable',
];
function action(value: unknown, operation: string, realmId: string, accountId: string): boolean {
  if (!record(value)) return false;
  if (value.state === 'prohibited')
    return keys(value, ['state', 'reason']) && prohibitedReasons.includes(String(value.reason));
  if (value.state === 'uncertain')
    return (
      keys(value, ['state', 'reason']) &&
      (value.reason === 'authority_unavailable' || value.reason === 'identity_unavailable')
    );
  if (value.state === 'unavailable') return keys(value, ['state', 'reason']) && value.reason === 'no_mounted_method';
  if (
    value.state !== 'available' ||
    !keys(value, ['state', 'method', 'path', 'body', 'expectedStatus', 'outcome']) ||
    !text(value.outcome, 160)
  )
    return false;
  // Advice cannot introduce a different target or an unmounted command.
  const base = `/v1/realms/${realmId}`;
  if (operation === 'addMember')
    return (
      value.method === 'POST' &&
      value.path === `${base}/members` &&
      value.expectedStatus === 202 &&
      record(value.body) &&
      value.body.accountId === accountId &&
      Object.keys(value.body).length === 1
    );
  if (operation === 'ban')
    return (
      value.method === 'PUT' &&
      value.path === `${base}/bans/${accountId}` &&
      value.expectedStatus === 200 &&
      record(value.body) &&
      text(value.body.reason, 1024) &&
      Object.keys(value.body).length === 1
    );
  if (operation === 'unban')
    return (
      value.method === 'DELETE' &&
      value.path === `${base}/bans/${accountId}` &&
      value.expectedStatus === 204 &&
      value.body === null
    );
  return false;
}
function member(value: unknown, realmId: string): value is NativeRealmMember {
  if (
    !record(value) ||
    !keys(value, ['accountId', 'episode', 'membership', 'identity', 'displayName', 'banState', 'actions']) ||
    !id(value.accountId) ||
    !text(value.episode, 64) ||
    !value.episode ||
    !['member', 'none'].includes(String(value.membership)) ||
    !identity(value.identity, value.accountId) ||
    !text(value.displayName, 4096) ||
    !['banned', 'clear', 'unknown'].includes(String(value.banState)) ||
    !record(value.actions)
  )
    return false;
  return (
    keys(value.actions, ['addMember', 'ban', 'unban', 'removeMember', 'reviseRole']) &&
    ['addMember', 'ban', 'unban', 'removeMember', 'reviseRole'].every((name) =>
      action((value.actions as Record<string, unknown>)[name], name, realmId, value.accountId as string),
    )
  );
}
function page(value: unknown, input: RealmMembersReadInput): value is NativeRealmMembersPage {
  if (
    !record(value) ||
    !keys(value, ['realmId', 'state', 'items', 'next', 'selected']) ||
    value.realmId !== input.realmId ||
    !['ready', 'preparing'].includes(String(value.state)) ||
    !Array.isArray(value.items) ||
    value.items.length > 20 ||
    !nullableText(value.next, 4096)
  )
    return false;
  if (value.state === 'preparing') return value.items.length === 0 && value.selected === null;
  if (!value.items.every((row) => member(row, input.realmId) && row.membership === 'member')) return false;
  if (new Set(value.items.map((row) => row.accountId)).size !== value.items.length) return false;
  return (
    value.selected === null ||
    (input.accountId !== undefined &&
      member(value.selected, input.realmId) &&
      value.selected.accountId === input.accountId)
  );
}

type NativeGet = (options: {
  query: { cursor?: string; accountId?: string };
  headers: { authorization: string };
  fetch: { cache: 'no-store' };
}) => Promise<{ status: number; data?: unknown; error?: unknown }>;

/** One bounded GET, including exact selection. No client hydration, refill, or identity fallback. */
export async function readNativeRealmMembers(
  client: KernelClient,
  input: RealmMembersReadInput,
  authorization: string,
): Promise<NativeRealmMembersRead> {
  const members = client.realms({ realmId: input.realmId }).members as unknown as { get?: NativeGet };
  if (typeof members.get !== 'function') return { kind: 'unavailable' };
  try {
    const result = await members.get({
      query: {
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
      },
      headers: { authorization },
      fetch: { cache: 'no-store' },
    });
    if (result.status === 401 || result.status === 403) return { kind: 'denied' };
    if (result.status === 404) return { kind: 'concealed' };
    const error = record(result.error) && record(result.error.value) ? result.error.value : result.data;
    if (result.status === 400 && record(error) && error.code === 'invalid_cursor') return { kind: 'expired' };
    if (result.status === 429 || result.status === 503) return { kind: 'unavailable' };
    if (result.status !== 200 || result.error || !page(result.data, input)) return { kind: 'failed' };
    if (new TextEncoder().encode(JSON.stringify(result.data)).byteLength > 600_000) return { kind: 'failed' };
    return result.data.state === 'preparing' ? { kind: 'preparing' } : { kind: 'ready', page: result.data };
  } catch {
    return { kind: 'failed' };
  }
}
