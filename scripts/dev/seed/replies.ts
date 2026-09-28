import { createHash } from 'node:crypto';
import type { SeedApi } from './api.ts';
import { seedKey } from './plan.ts';

function id(value: string): string {
  const hex = createHash('sha256').update(`rezics-demo-reply-v1:${value}`).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

/** These are ordinary member calls. Realm placement is a separate command; a reply
 * written in a Realm names it as its origin. */
/** The reply a seed target id names, so a replay can read it before writing. */
export const seedReplyId = (targetId: string) => `https://rezics.com/id/${id(targetId)}`;

export async function seedReply(api: SeedApi, session: { token: string; actingSubject: string },
  target: { id: string; work: string; revision: string; language: string; originRealm?: string }, body: string,
  parent?: { reply: string; revisionId: string }) {
  const reply = seedReplyId(target.id);
  const variantId = `urn:rezics:variant:${id(`${target.id}:variant`)}`;
  const draft = await api.post<{ revisionId: string }>('/v1/member-reply-drafts', {
    profile: 'member-reply-draft-v1', reply, variantId, rootTarget: target.work, rootRevision: target.revision,
    language: target.language, direction: 'ltr', expectedHead: null, body, actingSubject: session.actingSubject,
    ...target.originRealm ? { originRealm: target.originRealm } : {},
  }, session.token, seedKey('reply-draft', target.id));
  await api.post('/v1/realm-replies', { profile: 'realm-reply-identity-v1', reply, variantId,
    revisionId: draft.revisionId, author: session.actingSubject, rootTarget: target.work, rootRevision: target.revision,
    parentReply: parent?.reply ?? null, parentRevision: parent?.revisionId ?? null, contextRevision: null,
  }, session.token, seedKey('reply', target.id));
  return { reply, revisionId: draft.revisionId };
}
