import { BFF_PREFIX } from '../api/browser.ts';
import { relationshipsChanged } from './events.ts';
import type { Follow, FollowReceipt, FollowState, Membership, RelationshipsApi, JoinPolicy, Watch } from './types.ts';
import type { EntityPickerPage } from '@rezics/ui/entity-picker';
import type { MainClient } from '../discover/types.ts';

/** Pending Main contract: goal/g-938, modules/follows/contract.ts and routes/{memberships,notifications,managed-realms}.ts.
 * Keep this adapter together until G-938 is merged and the MainApp generator can carry its types. */
export class RelationshipError extends Error {
  constructor(readonly status: number) { super(`Relationship request failed (${status})`); }
}

export function mainRelationships(actingSubject: string, options: {
  origin?: string; headers?: HeadersInit; fetch?: typeof fetch;
} = {}): RelationshipsApi {
  async function request<T>(path: string, query?: object, body?: object, method = 'GET', key?: string): Promise<T> {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query ?? {})) if (value !== undefined && value !== null && value !== '')
      params.set(name, String(value));
    const headers = new Headers(options.headers);
    headers.set('accept', 'application/json');
    if (typeof window !== 'undefined') headers.set('x-rezics-page-url', window.location.href);
    if (body) { headers.set('content-type', 'application/json'); headers.set('idempotency-key', key ?? crypto.randomUUID()); }
    const response = await (options.fetch ?? fetch)(`${options.origin ?? BFF_PREFIX}${path}${params.size ? `?${params}` : ''}`,
      { method, headers, ...(body ? { body: JSON.stringify(body) } : {}), credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) { await response.body?.cancel(); throw new RelationshipError(response.status); }
    const result = await response.json() as T;
    if (body) relationshipsChanged();
    return result;
  }
  const actor = { actingSubject };
  const realmPath = (realm: string) => `/v1/realms/${encodeURIComponent(realm.slice(-36))}`;
  return {
    // G-938 c27c388 has manager-only membership changes, with no recipient Leave command.
    canLeave: false,
    follows: query => request<EntityPickerPage<Follow>>('/v1/me/follows', { ...actor, limit: 20, ...query }),
    memberships: query => request<EntityPickerPage<Membership>>('/v1/me/memberships', { ...actor, limit: 20, ...query }),
    state: (target, kind) => request<FollowState>('/v1/me/follow-state', { ...actor, target, kind }),
    set: (edit, key) => request<FollowReceipt>('/v1/follows', undefined,
      { profile: 'follow-command-v1', ...actor, ...edit }, 'POST', key),
    batch: (targets, key) => request<{ items: FollowReceipt[] }>('/v1/me/follows/batch', undefined,
      { profile: 'follow-batch-v1', ...actor, targets }, 'POST', key),
    joining: realm => request<JoinPolicy>(`${realmPath(realm)}/joining`, actor),
    join: (realm, policy, listed, key) => request(`${realmPath(realm)}/join`, undefined,
      { ...actor, expectedMembershipGeneration: policy.membershipGeneration,
        expectedPolicyRevision: policy.policyRevision, termsRevision: policy.termsRevision, listed }, 'POST', key),
    leave: () => Promise.reject(new RelationshipError(501)),
    mute: (target, kind, muted, key) => request('/v1/me/mutes', undefined,
      { ...actor, target, kind, strength: muted ? 'mute' : 'clear' }, 'PUT', key),
    block: (target, blocked, key) => request('/v1/me/blocked-people', undefined, { ...actor, target, blocked }, 'PUT', key),
    async watch(target, kind) {
      return (await request<{ watch: Watch | null }>('/v1/me/watches', { ...actor, target, kind })).watch;
    },
    setWatch: (target, kind, level, expectedRevision, key) => request<Watch>('/v1/me/watches', undefined,
      { ...actor, target, kind, level, expectedRevision }, 'POST', key),
  };
}

/** Older page story seams use Eden's established routes; the command and read mapping stays with the Main adapter. */
export function legacyFollowActions(target: string, actingSubject: string, main: () => MainClient,
  kind: 'agent' | 'external-author' | 'concept') {
  return {
    kind: 'ready' as const,
    async send(following: boolean, expectedRevision: string | null) {
      const { data, error } = await main().v1.follows.post({ profile: 'follow-command-v1', target, kind,
        actingSubject, following, expectedRevision }, { headers: { 'idempotency-key': crypto.randomUUID() } });
      if (data) return { kind: 'saved' as const, following: data.following, revision: data.revision };
      return error?.status === 409 ? { kind: 'stale' as const } : { kind: 'failed' as const };
    },
    async refresh() {
      const { data } = kind === 'external-author'
        ? await main().v1.authors['open-library']({ author: target.slice('open-library:'.length) }).follow.get({ query: { actingSubject } })
        : await main().v1.follows({ id: target.slice(-36) }).get({ query: { kind, actingSubject } });
      return data ? { following: data.following ?? false, revision: data.revision } : null;
    },
  };
}
