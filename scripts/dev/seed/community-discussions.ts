import { createHash } from 'node:crypto';
import { SeedApiError, type SeedApi } from './api.ts';
import { communityRealms, communityThreads, type CommunityThread } from './community-plan.ts';
import { person, publicWork, readMain } from './community-step.ts';
import { seedKey } from './plan.ts';
import { seedReply, seedReplyId } from './replies.ts';
import { refreshSeedTokens, type SeedState, type Session } from './state.ts';

// Discussions in the community Realms as members write them: a reply rooted on
// the Work's public text and written in the Realm, placed there by its author
// (trusted members need no queue), then replies to it and members' votes.
// A placed reply is read first, so a replay only reads.

const short = (id: string) => id.slice(-36);
interface Placed { reply: string; revisionId: string; placement: string }
interface Root { work: string; revision: string }

/** Main's selected public text of a Work: a reply anchors that exact revision. */
async function replyRoot(state: SeedState, id: string, roots: Map<string, Root>): Promise<Root> {
  const cached = roots.get(id);
  if (cached) return cached;
  const target = publicWork(state, id);
  if (!target) throw new Error(`Discussion root ${id} has no public text`);
  const selection = await readMain<{ selectedDraft: string }>(state.api,
    `/v1/main-versions/${short(target.work.mainVersion)}/selection`);
  if (!selection) throw new Error(`Discussion root ${id} has no selected text`);
  const root = { work: target.work.work, revision: selection.selectedDraft };
  roots.set(id, root);
  return root;
}

/** The author places their own reply; if the Realm asks for review, its owner approves it first. */
async function place(api: SeedApi, realm: { realm: string; owner: Session }, author: Session,
  reply: { reply: string; revisionId: string }, root: Root, key: string): Promise<string> {
  const exact = await readMain<{ revisionDigest: string }>(api,
    `/v1/member-replies/${short(reply.reply)}?actingSubject=${encodeURIComponent(author.actingSubject)}`, author.token);
  if (!exact) throw new Error('Discussion reply is unreadable by its author');
  const body = { profile: 'realm-reply-placement-v1', realm: realm.realm, reply: reply.reply,
    revisionId: reply.revisionId, revisionDigest: exact.revisionDigest, expectedHead: null };
  try {
    return (await api.post<{ placement: string }>('/v1/realm-reply-placements', { ...body, reviewDecisionId: null,
      actingSubject: author.actingSubject }, author.token, seedKey('community-placement', key))).placement;
  } catch (error) {
    if (!(error instanceof SeedApiError) || error.status !== 403) throw error;
  }
  const { owner } = realm;
  const review = await api.post<{ decisionId: string }>('/v1/realm-reply-reviews', {
    profile: 'realm-reply-review-v1', realm: realm.realm, reply: reply.reply, revisionId: reply.revisionId,
    revisionDigest: exact.revisionDigest, expectedGeneration: '0', supersedes: null, outcome: 'approved',
    method: 'human', methodRevision: 'realm-manager-v1',
    dependencyDigest: createHash('sha256').update(root.revision).digest('hex'),
    reasonReference: null, actingSubject: owner.actingSubject }, owner.token, seedKey('community-review', key));
  return (await api.post<{ placement: string }>('/v1/realm-reply-placements', { ...body,
    reviewDecisionId: review.decisionId, actingSubject: owner.actingSubject }, owner.token,
  seedKey('community-reviewed-placement', key))).placement;
}

async function discuss(state: SeedState, realm: { realm: string; owner: Session }, author: Session, root: Root,
  key: string, language: string, body: string, parent?: Placed): Promise<Placed> {
  const reply = seedReplyId(`community:${key}`);
  const visible = await readMain<{ placement: string; revisionId: string }>(state.api,
    `/v1/realms/${encodeURIComponent(realm.realm)}/replies/${encodeURIComponent(reply)}?actingSubject=${
      encodeURIComponent(author.actingSubject)}`, author.token);
  if (visible) return { reply, revisionId: visible.revisionId, placement: visible.placement };
  const written = await seedReply(state.api, author, { id: `community:${key}`, work: root.work,
    revision: root.revision, language, originRealm: realm.realm }, body, parent);
  return { ...written, placement: await place(state.api, realm, author, written, root, key) };
}

/** A vote needs Home's projection of the placement, which follows the relay; wait for it a while. */
async function vote(api: SeedApi, voter: Session, placement: string, value: 1 | -1, key: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      await api.post(`/v1/feed/${short(placement)}/vote`, { profile: 'feed-vote-command-v1', value,
        expectedRevision: null, actingSubject: voter.actingSubject }, voter.token, seedKey('community-vote', key));
      return;
    } catch (error) {
      if (!(error instanceof SeedApiError) || ![404, 409, 503].includes(error.status) || attempt >= 60) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

/** Voters are the Realm's other members in plan order: the first `up` vote up, the next `down` vote down. */
export function threadVoters(thread: Pick<CommunityThread, 'realm'>, author: string, up: number, down = 0) {
  const others = communityRealms.find(realm => realm.id === thread.realm)!.members.filter(id => id !== author);
  return [...others.slice(0, up).map(id => ({ id, value: 1 as const })),
    ...others.slice(up, up + down).map(id => ({ id, value: -1 as const }))];
}

export async function seedCommunityDiscussions(state: SeedState) {
  const roots = new Map<string, Root>();
  const votes: { voter: string; placement: string; value: 1 | -1; key: string }[] = [];
  let threads = 0, replies = 0;
  for (const thread of communityThreads) {
    await refreshSeedTokens(state);
    const realm = state.communityRealms.get(thread.realm);
    if (!realm) continue;
    await state.optional(`Community discussion ${thread.id}`, async () => {
      const root = await replyRoot(state, thread.work, roots);
      const top = await discuss(state, realm, person(state, thread.author), root, thread.id, thread.language, thread.body);
      threads++;
      for (const voter of threadVoters(thread, thread.author, thread.votes, thread.down)) {
        votes.push({ voter: voter.id, placement: top.placement, value: voter.value, key: `${voter.id}:${thread.id}` });
      }
      for (const [index, reply] of thread.replies.entries()) {
        const placed = await discuss(state, realm, person(state, reply.author), root, `${thread.id}:${index}`,
          reply.language ?? thread.language, reply.body, top);
        replies++;
        for (const voter of threadVoters(thread, reply.author, reply.votes ?? 0)) {
          votes.push({ voter: voter.id, placement: placed.placement, value: voter.value,
            key: `${voter.id}:${thread.id}:${index}` });
        }
      }
    });
  }
  let voted = 0;
  for (const item of votes) {
    await refreshSeedTokens(state);
    const done = await state.optional('Community discussion vote', () =>
      vote(state.api, person(state, item.voter), item.placement, item.value, item.key));
    if (done !== null) voted++;
  }
  state.commentCount += threads;
  state.replyCount += replies;
  console.log(`Community discussions: ${threads}/${communityThreads.length} threads, ${replies} replies, ${voted} votes.`);
}
