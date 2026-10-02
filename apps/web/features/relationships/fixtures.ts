import { RelationshipError } from './api.ts';
import { relationshipsChanged } from './events.ts';
import type { Follow, FollowEdit, FollowReceipt, FollowState, JoinPolicy, Membership, RelationshipsApi, Watch } from './types.ts';

export const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
export const target = (n: number) => `https://rezics.com/id/${String(n).padStart(8, '0')}-aaaa-4aaa-8aaa-000000000000`;
export const fixtureFollow = (n: number, kind = 'space'): Follow => ({
  id: target(n), kind, revision: `r${n}`, available: true,
  name: { value: n === 10 ? '中文网络小说' : n === 11 ? 'مكتبة الخيال' : `Community ${n}`, language: n === 10 ? 'zh-Hans' : n === 11 ? 'ar' : 'en',
    direction: n === 11 ? 'rtl' : 'ltr' },
  icon: { kind: 'fallback', key: String(n) }, realm: kind === 'space' ? target(n + 10000) : null,
  href: kind === 'space' ? `/r/${target(n + 10000).slice(-36)}` : `/e/${target(n).slice(-36)}`,
  level: 'highlights', source: 'explicit', pinPosition: n === 10 ? 0 : null,
  newSince: { state: n === 10 ? 'new' : 'none', count: null, updatedAt: '2026-10-02T00:00:00Z' },
});

export function memoryRelationships(initial: Follow[] = [], failure?: 'read' | 'write') {
  const follows = new Map(initial.map(item => [item.id, { ...item }]));
  const member = new Map<string, Membership>();
  const watches = new Map<string, Watch>();
  const calls: { operation: string; body: unknown; key?: string }[] = [];
  let revision = 100000;
  let unavailable = failure;
  const canonical = (id: string) => [...follows.values()].find(item => item.id === id || item.realm === id)?.id ?? id;
  const state = (id: string): FollowState => {
    const item = follows.get(canonical(id));
    return { following: !!item, revision: item?.revision ?? null, level: item?.level ?? null, source: item?.source ?? null,
      pinPosition: item?.pinPosition ?? null };
  };
  const policy = (realm: string): JoinPolicy => ({ policyRevision: '3', termsRevision: 'rules-7', selfJoin: true, open: true,
    membershipGeneration: member.get(realm)?.generation ?? '0', state: member.has(realm) ? 'joined' : 'absent' });
  const edits = (values: FollowEdit[]): FollowReceipt[] => {
    for (const edit of values) {
      const before = follows.get(canonical(edit.target));
      if (edit.expectedRevision !== undefined && edit.expectedRevision !== (before?.revision ?? null)) throw new RelationshipError(409);
    }
    return values.map(edit => {
      const id = canonical(edit.target), before = follows.get(id);
      const next = { ...(before ?? fixtureFollow(++revision, edit.kind ?? 'space')), id,
        revision: `r${++revision}`, source: edit.following === undefined ? before?.source ?? 'explicit' : 'explicit' as const,
        level: edit.level ?? before?.level ?? 'highlights', pinPosition: edit.pinPosition === undefined ? before?.pinPosition ?? null : edit.pinPosition };
      if (edit.following !== false) follows.set(id, next); else follows.delete(id);
      return { target: id, kind: next.kind, following: edit.following !== false, revision: next.revision,
        level: next.level, source: next.source, pinPosition: next.pinPosition };
    });
  };
  const api: RelationshipsApi = {
    canLeave: true,
    async follows(query = {}) {
      if (unavailable === 'read') throw new RelationshipError(503);
      let items = [...follows.values()].filter(item => (!query.kind || item.kind === query.kind)
        && (!query.q || item.name?.value.toLowerCase().includes(query.q.toLowerCase())));
      if (query.order === 'pinned') items = items.sort((a, b) => (a.pinPosition ?? 10000) - (b.pinPosition ?? 10000));
      const offset = Number(query.cursor ?? 0);
      return { items: items.slice(offset, offset + 20), nextCursor: offset + 20 < items.length ? String(offset + 20) : null,
        complete: offset + 20 >= items.length };
    },
    async memberships(query = {}) {
      if (unavailable === 'read') throw new RelationshipError(503);
      const items = [...member.values()].filter(item => !query.q || item.name?.value.toLowerCase().includes(query.q.toLowerCase()));
      const offset = Number(query.cursor ?? 0);
      return { items: items.slice(offset, offset + 20), nextCursor: offset + 20 < items.length ? String(offset + 20) : null, complete: offset + 20 >= items.length };
    },
    async state(id) { if (unavailable === 'read') throw new RelationshipError(503); return state(id); },
    async set(edit, key) { calls.push({ operation: 'follow', body: edit, key });
      if (unavailable === 'write') throw new RelationshipError(503);
      const receipt = edits([edit])[0]!; relationshipsChanged(); return receipt; },
    async batch(values, key) { calls.push({ operation: 'batch', body: values, key });
      if (unavailable === 'write') throw new RelationshipError(503);
      if (values.length > 20) throw new Error('Batch bound');
      const receipt = { items: edits(values) }; relationshipsChanged(); return receipt; },
    async joining(realm) { return policy(realm); },
    async join(realm, basis, listed, key) {
      calls.push({ operation: 'join', body: { realm, basis, listed }, key });
      if (basis.membershipGeneration !== policy(realm).membershipGeneration) throw new RelationshipError(409);
      const id = canonical(realm), before = follows.get(id);
      const follow = before ?? { ...fixtureFollow(++revision), id, realm, source: 'join' as const };
      follows.set(id, follow);
      member.set(realm, { membershipId: `m${++revision}`, generation: '1', realm, space: id, member: actor,
        available: true, name: follow.name, following: true, level: follow.level, source: follow.source, pinPosition: follow.pinPosition });
      relationshipsChanged();
    },
    async leave(realm, generation, key) {
      calls.push({ operation: 'leave', body: { realm, generation }, key });
      if (generation !== member.get(realm)?.generation) throw new RelationshipError(409);
      member.delete(realm);
      const id = canonical(realm);
      if (follows.get(id)?.source === 'join') follows.delete(id);
      relationshipsChanged();
    },
    async mute(id, kind, muted, key) { calls.push({ operation: 'mute', body: { id, kind, muted }, key }); },
    async block(id, blocked, key) { calls.push({ operation: 'block', body: { id, blocked }, key }); },
    async watch(id) { return watches.get(id) ?? null; },
    async setWatch(id, kind, level, expectedRevision, key) {
      calls.push({ operation: 'watch', body: { id, kind, level, expectedRevision }, key });
      const before = watches.get(id);
      if ((before?.revision ?? null) !== expectedRevision) throw new RelationshipError(409);
      const next = { level, reason: 'manual', revision: String(Number(before?.revision ?? 0) + 1) };
      watches.set(id, next); return next;
    },
  };
  return { api, calls, follows, member, recover: () => { unavailable = undefined; } };
}
