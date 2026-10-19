import { fromPlainText } from '@rezics/document';
import { browserMainApi } from '../api/browser.ts';
import { directionOf } from '../studio/types.ts';
import { mainAuthorApi, type AuthorReplyTarget } from './author-api.ts';

const iri = (n: number) => `https://rezics.com/id/11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const revision = '22222222-2222-4222-8222-222222222222';
const corrected = '33333333-3333-4333-8333-333333333333';
export const authorFixture = {
  actor: iri(1), other: iri(2), reply: iri(3), realm: iri(4), root: iri(5), rootRevision: iri(6),
  placement: iri(7), nextPlacement: iri(8), withdrawal: iri(9), revision, corrected,
  variant: 'urn:rezics:variant:44444444-4444-4444-8444-444444444444',
  body: 'An original post with its own history.',
};

export const authorTarget: AuthorReplyTarget = {
  reply: authorFixture.reply, realm: authorFixture.realm, author: authorFixture.actor,
  placement: authorFixture.placement, revisionId: authorFixture.revision,
};

/** A transport stand-in for adapter and interaction tests, never a signed-in API proof. */
export function authorTransport(options: { fail?: 'draft' | 'place' | 'withdraw'; status?: number; code?: string; foreign?: boolean; wrongReceipt?: boolean } = {}) {
  const f = authorFixture;
  const calls: { url: URL; method: string; body: Record<string, unknown> | null; key: string | null }[] = [];
  let failed = false;
  let placed = false;
  let withdrawn = false;
  const fetcher = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    const key = new Headers(init?.headers).get('idempotency-key');
    calls.push({ url, method, body, key });
    const path = url.pathname;
    const step = path.endsWith('member-reply-drafts') ? 'draft'
      : body?.profile === 'realm-reply-placement-withdrawal-v1' ? 'withdraw' : 'place';
    if (method === 'POST' && options.fail === step && !failed) {
      failed = true;
      // A transport failure can arrive after commitment. Retry must use the same key.
      if (!options.status || options.status >= 500) {
        if (step === 'place') placed = true;
        if (step === 'withdraw') withdrawn = true;
      }
      return Response.json({ code: options.code ?? 'unavailable' }, { status: options.status ?? 503 });
    }
    if (method === 'GET' && path.includes('/member-replies/')) return Response.json({
      reply: f.reply, author: options.foreign ? f.other : f.actor,
      rootTarget: f.root, rootRevision: f.rootRevision, originRealm: null, spoiler: false,
      variantId: f.variant, revisionId: f.revision, body: f.body,
      document: fromPlainText(f.body, 'blocks'), revisionDigest: 'a'.repeat(64),
      parentReply: null, parentRevision: null,
    });
    if (method === 'GET' && path.includes('/replies/')) return withdrawn
      ? Response.json({ code: 'realm_reply_unavailable' }, { status: 404 })
      : Response.json({ profile: 'realm-reply-placement-v1', placement: placed ? f.nextPlacement : f.placement,
        realm: f.realm, reply: f.reply, revisionId: placed ? f.corrected : f.revision,
        reviewDecisionId: f.revision, rootTarget: f.root, author: f.actor });
    if (method === 'GET' && path.includes('/content-revisions/')) return Response.json({
      reference: { owner: 'content', resourceId: f.reply, variantId: f.variant, revisionId: f.revision,
        format: 'rezics-content-json-v1', model: 'member-reply-v1', byteDigest: 'a'.repeat(64), byteLength: 100,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: directionOf('en'), sourceRevision: null,
        predecessor: null, provenance: { author: f.actor } },
      serializedJson: '{}', body: { body: f.body, document: fromPlainText(f.body, 'blocks'), spoiler: false },
    });
    if (step === 'draft') return Response.json({ reply: f.reply, variantId: f.variant,
      revisionId: f.corrected, revisionDigest: 'b'.repeat(64), predecessor: f.revision,
      deleted: false, sourcePosition: { owner: 'content', dataEpoch: 'fixture', sequence: '2' }, replayed: false });
    if (step === 'withdraw') {
      const replayed = withdrawn;
      withdrawn = true;
      return Response.json({ profile: 'realm-reply-placement-withdrawal-v1', realm: f.realm,
        reply: options.wrongReceipt ? f.other : f.reply, revisionId: f.revision, withdrawnPlacement: f.placement,
        withdrawal: f.withdrawal, replayed });
    }
    placed = true;
    return Response.json({ profile: 'realm-reply-placement-v1', realm: f.realm,
      reply: options.wrongReceipt ? f.other : f.reply, revisionId: f.corrected,
      placement: f.nextPlacement, reviewDecisionId: f.revision, reviewGeneration: '1', replayed: false });
  }, { preconnect: fetch.preconnect });
  const main = browserMainApi('https://author.invalid', { fetcher });
  return { main, api: mainAuthorApi(main), calls };
}
