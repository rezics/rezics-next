import { accessCheck, AuthenticationError, type AccessCheck } from '../request/access.ts';
import type { CursorBinding } from '../tokens/cursor.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readPartition } from '../partition/partition.ts';
import { decodeAuthorItemKey, encodeAuthorItemKey } from './author-item-reads.ts';
import { prepareEditionSubjectIdentities } from './edition-subject.ts';
import type { AnchoredPosition, ReadContext } from './model.ts';
import { ContentNotFoundError, readOwnDraftMetadata, readPost, snapshot,
  type ContentReadDependencies, type NativeDraftMetadata } from './reads.ts';
import draftPage from './own-drafts-page.sql';

export type OwnDraftActions = Readonly<{ resume: string; edit: string | null; publish: string | null; erase: string | null }>;
export type OwnDraftEntry = NativeDraftMetadata & Readonly<{ language: string | null; actions: OwnDraftActions }>;
export type OwnDraftInput = Readonly<{ cursor?: string; limit?: number }>;
export type OwnDraftPage = Readonly<{
  state: 'ready' | 'preparing'; entries: readonly OwnDraftEntry[]; nextCursor: string | null;
  viewer: { accountId: string; authnEpoch: number }; anchors: readonly AnchoredPosition[];
}>;
type Candidate = { item_id: string; thread_id: string; created_at: string;
  draft_revision_id: string | null; draft_language: string | null };

/** The acting account must be the selected home, including organizations. The
 * canonical account read repeats current session admission, delegation and consent.
 */
async function ownAccount(deps: ContentReadDependencies, accountId: string, context: ReadContext) {
  if (context.actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  const route = routeOf(accountId);
  if (route === null || accountId !== context.actor.accountId) throw new ContentNotFoundError();
  const check = await accessCheck(deps.access, context.actor, 'account:read', { route, id: accountId },
    { pool: deps.pool, deadline: context.deadline });
  const verify = async () => {
    const result = await snapshot(deps, accountId, context, client => check(client));
    if (!result.value) throw new ContentNotFoundError();
    return result.anchor;
  };
  await verify();
  return { verify, route, actor: context.actor };
}

function scope(accountId: string, context: ReadContext, limit: number): CursorBinding {
  if (context.actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  return { operation: 'content.own-drafts.list', parameters: { accountId, limit,
    viewer: context.actor.accountId, clientId: context.actor.clientId, requestedBy: context.actor.requestedBy,
    authnEpoch: context.actor.authnEpoch, scopes: [...context.actor.scopes].sort().join(' ') } };
}

async function subjects(deps: ContentReadDependencies, metadata: NativeDraftMetadata, context: ReadContext) {
  const read = await prepareEditionSubjectIdentities(deps, metadata.subjectIds, context);
  const verify = async () => {
    const values = await read();
    return metadata.subjectIds.every(id => values.get(id)?.kind === 'available');
  };
  return { verify, allowed: await verify() };
}

async function actions(deps: ContentReadDependencies, metadata: NativeDraftMetadata, context: ReadContext,
  accountId: string): Promise<OwnDraftActions> {
  const route = routeOf(metadata.id)!;
  const checks: AccessCheck[] = [];
  for (const action of ['post:revise','post:erase']) checks.push(await accessCheck(deps.access, context.actor,
    action, { route, id: metadata.id }, { pool: deps.pool, deadline: context.deadline }));
  const allowed = await snapshot(deps, metadata.id, context, async client => {
    const result: boolean[] = [];
    for (const check of checks) result.push(await check(client));
    return result;
  });
  const edit = `/v1/posts/${metadata.id}/revisions`;
  return { resume: `/v1/accounts/${accountId}/drafts/${metadata.id}?threadId=${metadata.threadId}`,
    edit: allowed.value[0] ? edit : null, publish: allowed.value[0] ? edit : null,
    erase: allowed.value[1] ? `/v1/posts/${metadata.id}` : null };
}

/** One actor-home partial range, raw <=20. Withheld/stale candidates consume
 * their slots; failure throws without publishing a continuation past that slot.
 */
export async function listOwnDrafts(deps: ContentReadDependencies, accountId: string, context: ReadContext,
  input: OwnDraftInput = {}): Promise<OwnDraftPage> {
  const admission = await ownAccount(deps, accountId, context);
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new RangeError('Page limit must be 1 to 20');
  const binding = scope(accountId, context, limit);
  const now = (deps.clock?.() ?? new Date()).getTime();
  const selected = await snapshot(deps, accountId, context, async client => {
    // Decode uses the home epoch observed inside this same snapshot.
    const partition = await readPartition(client, partitionOf(admission.route));
    const epoch = partition?.epoch;
    if (epoch === undefined) throw new Error('Draft home partition is unavailable');
    const after = input.cursor === undefined ? null : decodeAuthorItemKey(deps.tokens, binding, input.cursor, epoch, now);
    const parameters = { route: admission.route, account_id: accountId, limit,
      after_at: after?.createdAt ?? 'infinity', after_id: after?.itemId ?? '00000000-0000-0000-0000-000000000000' };
    const candidates = await client.query<Candidate>(draftPage.sql,
      draftPage.params.map(name => parameters[name as keyof typeof parameters]));
    const coverage = await client.query<{ complete: boolean }>(
      'SELECT complete FROM content.own_draft_progress WHERE singleton=0');
    // Source pending is a partial author-leading prefix; delayed delivery cannot
    // turn a known server draft into a complete empty inventory.
    const pending = await client.query(
      `SELECT 1 FROM content.post WHERE author_account_id=$1 AND draft_locator_pending
       AND visibility='draft' AND availability='available' LIMIT 1`, [accountId]);
    return { candidates: candidates.rows, ready: coverage.rows[0]?.complete === true && pending.rows.length === 0 };
  });
  const entries: OwnDraftEntry[] = [];
  const anchors: AnchoredPosition[] = [selected.anchor];
  for (const candidate of selected.value.candidates) {
    const initial = await readOwnDraftMetadata(deps, candidate.thread_id, candidate.item_id, context);
    anchors.push(initial.anchor);
    if (!initial.value || initial.value.authorId !== accountId || initial.value.revisionId !== candidate.draft_revision_id)
      continue;
    const references = await subjects(deps, initial.value, context);
    if (!references.allowed) continue;
    const applicable = await actions(deps, initial.value, context, accountId);
    const final = await readOwnDraftMetadata(deps, candidate.thread_id, candidate.item_id, context);
    anchors.push(final.anchor);
    if (!final.value || final.value.revisionId !== initial.value.revisionId ||
        JSON.stringify(final.value) !== JSON.stringify(initial.value) || !(await references.verify())) continue;
    entries.push({ ...final.value, language: candidate.draft_language, actions: applicable });
  }
  anchors.push(await admission.verify());
  const last = selected.value.candidates.at(-1);
  return { entries, state: selected.value.ready ? 'ready' : 'preparing',
    viewer: { accountId, authnEpoch: admission.actor.authnEpoch }, anchors,
    nextCursor: last && selected.value.candidates.length === limit
      ? encodeAuthorItemKey(deps.tokens, binding, { createdAt: last.created_at, itemId: last.item_id }, selected.anchor.epoch, now)
      : null };
}

/** Exact selection uses native body/revision disclosure after private and Subject
 * admission. The existing If-Match save/publish and own-erase commands own writes.
 */
export async function resumeOwnDraft(deps: ContentReadDependencies, accountId: string, threadId: string,
  postId: string, context: ReadContext) {
  const admission = await ownAccount(deps, accountId, context);
  const metadata = await readOwnDraftMetadata(deps, threadId, postId, context);
  if (!metadata.value || metadata.value.authorId !== accountId) throw new ContentNotFoundError();
  const references = await subjects(deps, metadata.value, context);
  if (!references.allowed) throw new ContentNotFoundError();
  const post = await readPost(deps, threadId, postId, context);
  if (!post.value || !('revisionId' in post.value) || post.value.availability !== 'available' ||
      post.value.authorId !== accountId || post.value.visibility !== 'draft' ||
      post.value.revisionId !== metadata.value.revisionId || !(await references.verify())) throw new ContentNotFoundError();
  await admission.verify();
  return post;
}
