import type { MainClient } from '../../feed/types.ts';
import type { PendingInvitation } from './invitations-read.ts';
import type { NotificationWindow, StreamItem } from './window.ts';

// Story data: an inbox as Main's notification stream returns it, and just
// enough of the Eden client for the page's reads and commands, in memory.

export const NOW = Date.parse('2026-09-28T09:00:00.000Z');
const id = (n: number) => `${String(n).padStart(8, '0')}-5555-4a6f-8c2d-3e7b5c1a9f40`;
const iri = (n: number) => `https://rezics.com/id/${id(n)}`;
const daniel = { id: iri(802), name: 'Daniel Chen', handle: 'daniel_chen', avatar: null };
const aria = { id: iri(803), name: 'Aria Wang 王雅', handle: 'aria_wang', avatar: null };

function item(sequence: number, display: StreamItem['display'], read = false, minutes = sequence * 45): StreamItem {
  return { id: id(sequence), sequence: String(sequence), purpose: 'social', topic: 'reply', read,
    state: display ? 'active' : 'withdrawn', subject: null, display, saved: false, done: false, triageRevision: null,
    reason: null, proposal: null, createdAt: new Date(NOW - minutes * 60_000).toISOString() };
}

const target = (title: string | null, excerpt: string | null, linkTarget: string | null, language = 'en',
  reviewId: string | null = null) => ({ title, excerpt, language, linkTarget, reviewId });
// Where each notification happened, as Main names it (G-329).
const nowhere = { realmName: null, realmRouteSegment: null, roleName: null, roleChange: null };
const fiction = { realmName: 'Fiction · 小说', realmRouteSegment: 'fiction', roleName: null, roleChange: null };
const classics = { realmName: 'Classic Literature', realmRouteSegment: id(902), roleName: null, roleChange: null };

/** Sequences 101–108, oldest first as Main pages them; three replies share a thread. */
export const inbox: StreamItem[] = [
  item(101, null, true, 3000),
  item(102, { kind: 'follow', actor: aria, realm: null, ...nowhere, groupKey: null, target: target(null, null, null) },
    true, 2000),
  item(103, { kind: 'realm_role_change', actor: daniel, realm: iri(901), ...fiction, roleName: 'Community moderators',
    roleChange: 'given',
    groupKey: null, target: target(null, null, iri(901)) }, true, 1500),
  item(104, { kind: 'reply', actor: aria, realm: iri(901), ...fiction, groupKey: 'thread-1',
    target: target('雨夜书店', '第三章的结尾太好了，那张车票到底是谁寄的？', iri(701), 'zh-Hans') }, false, 300),
  item(105, { kind: 'reply', actor: daniel, realm: iri(901), ...fiction, groupKey: 'thread-1',
    target: target('雨夜书店', 'I think the ticket is from her mother.', iri(702)) }, false, 200),
  item(106, { kind: 'submission_decision', actor: null, realm: iri(902), ...classics, groupKey: null,
    target: target('Middlemarch: A Study of Provincial Life', 'accepted', iri(703)) }, false, 90),
  item(107, { kind: 'moderation_outcome', actor: null, realm: iri(902), ...classics, groupKey: null,
    target: target(null, 'removed', iri(704)) }, false, 40),
  item(108, { kind: 'reply', actor: daniel, realm: iri(901), ...fiction, groupKey: 'thread-1',
    target: target('雨夜书店', 'Also: chapter four is up!', iri(705)) }, false, 10),
];

/** Reviews: someone reviewed your Work (its opening shows unless it discusses the plot), and one of yours helps readers. */
export const reviews: StreamItem[] = [
  item(111, { kind: 'review', actor: aria, realm: null, ...nowhere, groupKey: null,
    target: target('雨夜书店', 'Quiet, rainy and exactly as sad as it should be.', iri(801), 'en', id(111)) }, false, 30),
  item(112, { kind: 'review_helpful', actor: null, realm: iri(902), ...classics, groupKey: null,
    target: target('Middlemarch: A Study of Provincial Life', null, iri(802), 'en', id(112)) }, false, 5),
];

export const invitationNotice: StreamItem = { ...item(113, { kind: 'realm_invitation', actor: daniel,
  realm: iri(901), ...fiction, groupKey: null, target: target(null, null, iri(901)) }),
  subject: { owner: 'access', ref: id(501), revision: null } };

export const roleTaken: StreamItem = item(114, { kind: 'realm_role_change', actor: daniel,
  realm: iri(901), ...fiction, roleName: 'Community moderators', roleChange: 'taken', groupKey: null,
  target: target(null, null, iri(901)) });

/** An open invitation from Daniel to join Fiction. */
export const invitations: PendingInvitation[] = [{ id: id(501), realm: iri(901), realmName: 'Fiction · 小说',
  realmLanguage: 'en', realmIcon: { kind: 'fallback', key: 'fiction' }, realmHref: '/r/fiction', inviterName: 'Daniel Chen',
  expiresAt: new Date(NOW + 5 * 86_400_000).toISOString() }];

/** The invitation answer Main records; each call is kept in `calls`. */
export function memoryInvitations(options: { refuse?: boolean } = {}) {
  const calls: string[] = [];
  const realms = (params: { realm: string }) => ({ invitations: (invitation: { invitation: string }) => ({ response: {
    post: (body: { action: string; listed: boolean }) => {
      calls.push(`${body.action}:${params.realm.slice(0, 8)}:${invitation.invitation.slice(0, 8)}:${body.listed}`);
      return Promise.resolve(options.refuse ? { data: null, error: { status: 503, value: null } }
        : { data: { invitation: {}, replayed: false }, error: null });
    } } }) });
  return { main: { v1: { realms } } as unknown as MainClient, calls };
}

export function inboxWindow(items: StreamItem[], from = '0', head = '108'): NotificationWindow {
  const groups = [...new Set(items.flatMap(entry => entry.display?.groupKey ? [entry.display.groupKey] : []))]
    .map(key => ({ kind: 'reply', key, itemIds: items.filter(entry => entry.display?.groupKey === key).map(entry => entry.id) }));
  return { generation: '1', head, readThrough: '100', items: [...items].reverse(), groups, from };
}

/** The Eden calls the page makes, answered from `stream`; each call is recorded. */
export function memoryInbox(stream: StreamItem[], options: { refuse?: boolean } = {}) {
  const calls: string[] = [];
  const answer = <T>(data: T) => Promise.resolve(options.refuse
    ? { data: null, error: { status: 503, value: null } } : { data, error: null });
  const notifications = Object.assign((params: { item: string }) => ({ read: { put: () => {
    calls.push(`read:${params.item.slice(0, 8)}`);
    return answer({ profile: 'notification-item-read-v1', id: params.item, readAt: new Date(NOW).toISOString() });
  } } }), {
    get: ({ query }: { query: { after: string; limit: number } }) => {
      calls.push(`page:${query.after}:${query.limit}`);
      const after = Number(query.after.split(':')[1]);
      const page = stream.filter(entry => Number(entry.sequence) > after).slice(0, query.limit);
      return answer({ profile: 'notification-stream-page-v1', generation: '1', head: '108', reset: false,
        readThrough: '100', items: page, groups: [], next: null });
    },
    hint: { get: () => answer({ profile: 'notification-stream-hint-v1', generation: '1', head: '108' }) },
  });
  const main = { v1: { me: { notifications, 'notification-read-watermarks': { inbox: { put: (body: {
    readThrough: string }) => {
    calls.push(`read-through:${body.readThrough}`);
    return answer({ profile: 'notification-read-watermark-v1', generation: '1', readThrough: body.readThrough });
  } } } } } } as unknown as MainClient;
  return { main, calls };
}
