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
  correctedBody: 'A published correction.',
  nextCorrected: '55555555-5555-4555-8555-555555555555',
  concurrent: '66666666-6666-4666-8666-666666666666',
  latestPlacement: iri(10),
};

export const authorTarget: AuthorReplyTarget = {
  reply: authorFixture.reply, realm: authorFixture.realm, author: authorFixture.actor,
  placement: authorFixture.placement, revisionId: authorFixture.revision,
};

/** A transport stand-in for adapter and interaction tests, never a signed-in API proof. */
export function authorTransport(options: {
  fail?: 'head' | 'draft' | 'place' | 'withdraw'; status?: number; code?: string;
  foreign?: boolean; wrongReceipt?: boolean; wrongRevision?: boolean;
  publishedCorrected?: boolean; draftAhead?: boolean; variantsOnNextPage?: boolean;
  authoringSubject?: string | null;
} = {}) {
  const f = authorFixture;
  const calls: { url: URL; method: string; body: Record<string, unknown> | null; key: string | null }[] = [];
  let failed = false;
  let withdrawn = false;
  let selectedRevision = options.publishedCorrected ? f.corrected : f.revision;
  let placement = options.publishedCorrected ? f.nextPlacement : f.placement;
  let draftHead = options.draftAhead ? f.concurrent : selectedRevision;
  const revisions = new Map([
    [f.revision, { body: f.body, document: fromPlainText(f.body, 'blocks'), digest: 'a'.repeat(64), predecessor: null as string | null }],
    [f.corrected, { body: f.correctedBody, document: fromPlainText(f.correctedBody, 'blocks'), digest: 'b'.repeat(64), predecessor: f.revision }],
    [f.concurrent, { body: 'Private unpublished draft.', document: fromPlainText('Private unpublished draft.', 'blocks'), digest: 'c'.repeat(64), predecessor: f.corrected }],
  ]);
  const drafts = new Map<string, { revisionId: string; revisionDigest: string; predecessor: string }>();
  const placements = new Map<string, { placement: string; revisionId: string }>();
  const fetcher = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    const key = new Headers(init?.headers).get('idempotency-key');
    calls.push({ url, method, body, key });
    const path = url.pathname;
    const step = path.endsWith('content-variants') ? 'head' : path.endsWith('member-reply-drafts') ? 'draft'
      : body?.profile === 'realm-reply-placement-withdrawal-v1' ? 'withdraw' : 'place';
    const saveDraft = () => {
      let saved = drafts.get(key!);
      const replayed = Boolean(saved);
      if (!saved) {
        if (body?.expectedHead !== draftHead) return Response.json({ code: 'stale_head' }, { status: 409 });
        const revisionId = draftHead === f.revision ? f.corrected : f.nextCorrected;
        saved = { revisionId, revisionDigest: 'b'.repeat(64), predecessor: draftHead };
        drafts.set(key!, saved);
        revisions.set(revisionId, { body: String(body.body),
          document: (body.document as ReturnType<typeof fromPlainText> | undefined) ?? fromPlainText(String(body.body), 'blocks'),
          digest: saved.revisionDigest, predecessor: draftHead });
        draftHead = revisionId;
      }
      return Response.json({ reply: f.reply, variantId: f.variant, ...saved, deleted: false,
        sourcePosition: { owner: 'content', dataEpoch: 'fixture', sequence: '2' }, replayed });
    };
    const place = () => {
      let saved = placements.get(key!);
      const replayed = Boolean(saved);
      if (!saved) {
        if (body?.expectedHead !== placement) return Response.json({ code: 'realm_reply_stale' }, { status: 409 });
        selectedRevision = String(body.revisionId);
        placement = placement === f.placement ? f.nextPlacement : f.latestPlacement;
        saved = { revisionId: selectedRevision, placement };
        placements.set(key!, saved);
      }
      return Response.json({ profile: 'realm-reply-placement-v1', realm: f.realm,
        reply: options.wrongReceipt ? f.other : f.reply, ...saved,
        reviewDecisionId: f.revision, reviewGeneration: '1', replayed });
    };
    if ((method === 'POST' || step === 'head') && options.fail === step && !failed) {
      failed = true;
      // A transport failure can arrive after commitment. Retry must use the same key.
      if (!options.status || options.status >= 500) {
        if (step === 'draft') saveDraft();
        if (step === 'place') place();
        if (step === 'withdraw') withdrawn = true;
      }
      if (step === 'draft' && options.code === 'stale_head') draftHead = f.concurrent;
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
      : Response.json({ profile: 'realm-reply-placement-v1', placement,
        realm: f.realm, reply: f.reply, revisionId: selectedRevision,
        reviewDecisionId: f.revision, rootTarget: f.root, author: f.actor });
    if (method === 'GET' && step === 'head') {
      const firstPage = options.variantsOnNextPage && !url.searchParams.has('cursor');
      return Response.json({ work: f.reply,
        authoringSubject: options.authoringSubject === undefined ? f.actor : options.authoringSubject,
        items: [{ variantId: firstPage ? 'urn:rezics:variant:another' : f.variant,
          language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
          draftHead, publicationHead: null, eligibilityHead: null }],
        nextCursor: firstPage ? 'next-variant-page' : null,
        sourcePosition: { owner: 'content', dataEpoch: 'fixture', sequence: '2' } });
    }
    if (method === 'GET' && path.includes('/content-revisions/')) {
      const requested = path.split('/').at(-1)!;
      const revisionId = options.wrongRevision ? f.revision : requested;
      const exact = revisions.get(revisionId);
      if (!exact) return Response.json({ code: 'revision_unavailable' }, { status: 404 });
      return Response.json({
        reference: { owner: 'content', resourceId: f.reply, variantId: f.variant, revisionId,
          format: 'rezics-content-json-v1', model: 'member-reply-v1', byteDigest: exact.digest, byteLength: 100,
          language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: directionOf('en'), sourceRevision: null,
          predecessor: exact.predecessor, provenance: { author: f.actor } },
        serializedJson: '{}', body: { body: exact.body, document: exact.document, spoiler: false },
      });
    }
    if (step === 'draft') return saveDraft();
    if (step === 'withdraw') {
      const replayed = withdrawn;
      withdrawn = true;
      return Response.json({ profile: 'realm-reply-placement-withdrawal-v1', realm: f.realm,
        reply: options.wrongReceipt ? f.other : f.reply, revisionId: f.revision, withdrawnPlacement: f.placement,
        withdrawal: f.withdrawal, replayed });
    }
    return place();
  }, { preconnect: fetch.preconnect });
  const main = browserMainApi('https://author.invalid', { fetcher });
  return { main, api: mainAuthorApi(main), calls };
}
