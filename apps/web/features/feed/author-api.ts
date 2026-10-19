import { browserMainApi } from '../api/browser.ts';
import { bodyInput, editorValue } from '../document-editor/body.ts';
import type { MainClient } from './types.ts';

type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;
type Reply = Ok<ReturnType<MainClient['v1']['member-replies']>['get']>;
type Exact = Ok<ReturnType<MainClient['v1']['content-revisions']>['get']>;

export type AuthorFailure = 'sign-in' | 'denied' | 'stale' | 'conflict' | 'missing' | 'invalid' | 'failed';
export type AuthorResult<T> = { kind: 'done'; value: T } | { kind: AuthorFailure };

export function authorFailure(error?: { status: number; value?: unknown } | null): AuthorFailure {
  const value = error?.value;
  const code = value && typeof value === 'object' && 'code' in value ? value.code : null;
  if (error?.status === 401) return 'sign-in';
  if (error?.status === 403) return 'denied';
  if (error?.status === 404) return 'missing';
  if (error?.status === 409) {
    if (code === 'idempotency_conflict') return 'conflict';
    if (code === 'stale_head' || code === 'realm_reply_stale' || code === 'stale_eligibility_head') return 'stale';
  }
  if (error?.status === 400 || error?.status === 413 || error?.status === 422) return 'invalid';
  return 'failed';
}

export interface AuthorReplyTarget {
  reply: string;
  realm: string;
  author: string;
  /** When the full thread supplied them, opening the editor must still name these exact heads. */
  revisionId?: string;
  placement?: string;
}

export interface AuthorReplyBasis {
  reply: Reply;
  exact: Exact;
  placement: string;
  placedRevision: string;
  /** Author-only current draft head; independent of the selected public revision. */
  draftHead: string;
  language: string;
  direction: 'ltr' | 'rtl' | 'none';
  body: string;
}

export interface ReplyCorrection {
  key: string;
  actingSubject: string;
  target: AuthorReplyTarget;
  basis: AuthorReplyBasis;
  body: string;
  saved?: { revisionId: string; digest: string };
}

export interface ReplyWithdrawal {
  key: string;
  actingSubject: string;
  target: AuthorReplyTarget;
  placement: string;
  revisionId: string;
}

export interface AuthorApi {
  read(target: AuthorReplyTarget, actingSubject: string): Promise<AuthorResult<AuthorReplyBasis>>;
  correct(intent: ReplyCorrection, remember: (intent: ReplyCorrection) => void): Promise<AuthorResult<{
    reply: string; revisionId: string; placement: string;
  }>>;
  withdraw(intent: ReplyWithdrawal): Promise<AuthorResult<{ reply: string; withdrawal: string }>>;
}

/** Existing author owners admit every read/write again; the displayed author is only menu discovery. */
export function mainAuthorApi(main: MainClient = browserMainApi()): AuthorApi {
  const headers = (key: string, step: string) => ({ headers: { 'idempotency-key': `${key}:${step}` } });
  return {
    async read(target, actingSubject) {
      try {
        const read = await main.v1['member-replies']({ reply: target.reply.slice(-36) }).get({ query: { actingSubject } });
        if (!read.data) return { kind: authorFailure(read.error) };
        if (read.data.author !== actingSubject || read.data.author !== target.author) return { kind: 'denied' };
        const placed = await main.v1.realms({ realm: target.realm }).replies({ reply: target.reply }).get({ query: { actingSubject } });
        if (!placed.data) return { kind: authorFailure(placed.error) };
        if (placed.data.reply !== target.reply || placed.data.realm !== target.realm
          || placed.data.author !== actingSubject) return { kind: 'denied' };
        if (target.placement && placed.data.placement !== target.placement
          || target.revisionId && placed.data.revisionId !== target.revisionId) return { kind: 'stale' };
        let cursor: string | undefined;
        let draftHead: string;
        const cursors = new Set<string>();
        for (;;) {
          const heads = await main.v1.works({ id: target.reply.slice(-36) })['content-variants'].get({
            query: { actingSubject, ...(cursor ? { cursor } : {}) },
          });
          if (!heads.data) return { kind: authorFailure(heads.error) };
          if (heads.data.work !== target.reply || heads.data.authoringSubject !== actingSubject) return { kind: 'denied' };
          const variant = heads.data.items.find(item => item.variantId === read.data.variantId);
          if (variant) {
            if (!variant.draftHead) return { kind: 'missing' };
            draftHead = variant.draftHead;
            break;
          }
          const next = heads.data.nextCursor;
          if (!next) return { kind: 'missing' };
          if (cursors.has(next)) return { kind: 'failed' };
          cursors.add(next);
          cursor = next;
        }
        const exact = await main.v1['content-revisions']({ revision: placed.data.revisionId }).get({ query: { actingSubject } });
        if (!exact.data) return { kind: authorFailure(exact.error) };
        const { reference, body } = exact.data;
        if (reference.resourceId !== target.reply || reference.variantId !== read.data.variantId
          || reference.revisionId !== placed.data.revisionId || reference.language.kind !== 'tag'
          || typeof body.body !== 'string') return { kind: 'invalid' };
        return { kind: 'done', value: {
          reply: read.data, exact: exact.data, placement: placed.data.placement,
          placedRevision: placed.data.revisionId, draftHead, language: reference.language.tag,
          direction: reference.direction, body: editorValue(body.body, body.document),
        } };
      } catch { return { kind: 'failed' }; }
    },
    async correct(intent, remember) {
      const { basis, target, actingSubject } = intent;
      // Frozen requests saved before draftHead was recorded must replay their original CAS unchanged.
      const expectedHead = basis.draftHead ?? basis.reply.revisionId;
      try {
        if (!intent.saved) {
          const saved = await main.v1['member-reply-drafts'].post({
            profile: 'member-reply-draft-v1', reply: target.reply, variantId: basis.reply.variantId,
            rootTarget: basis.reply.rootTarget, rootRevision: basis.reply.rootRevision,
            originRealm: basis.reply.originRealm ?? null,
            language: basis.language, direction: basis.direction,
            expectedHead, actingSubject,
            ...(typeof basis.exact.body.spoiler === 'boolean' ? { spoiler: basis.exact.body.spoiler } : {}),
            ...bodyInput(intent.body),
          }, headers(intent.key, 'draft'));
          if (!saved.data) return { kind: authorFailure(saved.error) };
          if (saved.data.reply !== target.reply || saved.data.variantId !== basis.reply.variantId
            || saved.data.predecessor !== expectedHead || saved.data.deleted) return { kind: 'failed' };
          intent.saved = { revisionId: saved.data.revisionId, digest: saved.data.revisionDigest };
          remember({ ...intent });
        }
        const saved = intent.saved;
        const placed = await main.v1['realm-reply-placements'].post({
          profile: 'realm-reply-placement-v1', realm: target.realm, reply: target.reply,
          revisionId: saved.revisionId, revisionDigest: saved.digest,
          reviewDecisionId: null, expectedHead: basis.placement, actingSubject,
        }, headers(intent.key, 'place'));
        if (!placed.data) return { kind: authorFailure(placed.error) };
        if (placed.data.profile !== 'realm-reply-placement-v1' || placed.data.reply !== target.reply
          || placed.data.realm !== target.realm || placed.data.revisionId !== saved.revisionId) return { kind: 'failed' };
        return { kind: 'done', value: { reply: placed.data.reply, revisionId: placed.data.revisionId, placement: placed.data.placement } };
      } catch { return { kind: 'failed' }; }
    },
    async withdraw(intent) {
      try {
        const result = await main.v1['realm-reply-placements'].post({
          profile: 'realm-reply-placement-withdrawal-v1', realm: intent.target.realm,
          reply: intent.target.reply, expectedHead: intent.placement,
          expectedRevisionId: intent.revisionId, actingSubject: intent.actingSubject,
        }, headers(intent.key, 'withdraw'));
        if (!result.data) return { kind: authorFailure(result.error) };
        if (result.data.profile !== 'realm-reply-placement-withdrawal-v1'
          || result.data.realm !== intent.target.realm || result.data.reply !== intent.target.reply
          || result.data.revisionId !== intent.revisionId || result.data.withdrawnPlacement !== intent.placement)
          return { kind: 'failed' };
        return { kind: 'done', value: { reply: result.data.reply, withdrawal: result.data.withdrawal } };
      } catch { return { kind: 'failed' }; }
    },
  };
}
