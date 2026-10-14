import { randomUUID } from 'node:crypto';
import { ContentConflict } from '../../../../content/src/core.ts';
import { hasDocumentContent, type DocumentSnapshot } from '@rezics/document';
import { authoredDocumentBody } from '../../../../content/src/document-body.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { AdmissionConflict, AdmissionDenied, AdmissionExpired, type RegisteredAdmission, type VerifiedPrincipal } from '../access/admission.ts';
import { ContentDraftDenied, ContentDraftRightsDenied, ContentDraftStale } from '../content-publication/draft.ts';
import { saveVerifiedMemberReplyDraft, type CanonicalAboutReplyDraftResult } from '../content-publication/reply-draft.ts';
import { resolveTargets, TargetNotBound, TargetUnavailable } from '../target/resolve.ts';
import { workRead, WorkReadInvalid, WorkReadLimit, WorkReadMissing, WorkReadMoved } from '../work/read-session.ts';
import { parseLanguage } from '../display-language/tag.ts';
import { resolveZoneRoute, ZoneRouteMissing } from '../zone/route.ts';
import { readZoneConfiguration } from '../zone/configuration.ts';
import { RealmAboutThreadStore, type AboutPostOperation, type AboutTerminalOutcome } from './about-store.ts';
import { RealmReplyConflict, RealmReplyDenied, RealmReplyInvalid, RealmReplyStale, RealmReplyUnavailable } from './content-store.ts';
import { readReplyGraphReceipt } from './graph.ts';
import { realmReplyDigest } from './store.ts';
import type { CanonicalReplyParentReader } from './root.ts';

// Retain the owner's bounded error identity; the existing route adapter still
// owns HTTP status, code and body. Subclasses precede their base classes.
const terminalErrors = {
  'draft-rights-denied': ContentDraftRightsDenied, 'target-unavailable': TargetUnavailable,
  'reply-denied': RealmReplyDenied, 'reply-invalid': RealmReplyInvalid, 'reply-stale': RealmReplyStale,
  'admission-denied': AdmissionDenied, 'draft-denied': ContentDraftDenied, 'draft-stale': ContentDraftStale,
  'content-conflict': ContentConflict, 'target-not-bound': TargetNotBound,
  'read-missing': WorkReadMissing, 'read-moved': WorkReadMoved, 'read-invalid': WorkReadInvalid,
} as const;
/** Outcome table (the locked intent/owner receipt supplies the evidence):
 * - Invalid input / changed input under a key: 400 / 409 request rejection;
 *   these do not terminate any retained intent with a different valid input.
 * - Selected child waiting for its opener: recoverable 202, same operation.
 * - Definite basis/disclosure, draft/identity or admission refusal before
 *   dispatch: terminal only for an allocated, undispatched selection.
 * - A definite refusal before selection is an ordinary request rejection,
 *   with no stored terminal outcome or claim about a concurrent request.
 * - Dispatch without a completed owner outcome,
 *   missing receipt, transport/owner outage, admission/receipt conflict or
 *   read budget failure: recoverable 503.
 * - Successful graph receipt: finish native settlement; fresh post 201,
 *   exact or concurrent replay 200. This retains terminal success.
 * - Exact cancelled draft + ContentConflict: terminal Content refusal.
 * - Cancelled placement + ContentConflict or other uncertain cleanup failure:
 *   recoverable 503; retry the native owner to finish settlement and sealing.
 * - Cancelled placement + native denied/invalid/stale/expired refusal after
 *   cleanup: terminal; preserve that owner error, with expiry normalized stale.
 * - Replaced selection without dispatch: terminal stale, retained regardless
 *   of newer target/policy reads. Retained terminal outcomes replay unchanged.
 */
function terminalOutcome(error: unknown, phase: 'pre-dispatch' | 'placement'): AboutTerminalOutcome | null {
  if (phase === 'placement' && !(error instanceof RealmReplyDenied || error instanceof RealmReplyInvalid
    || error instanceof RealmReplyStale || error instanceof AdmissionDenied || error instanceof AdmissionExpired)) return null;
  if (error instanceof AdmissionExpired) return { kind: 'reply-stale', message: 'Discussion admission expired' };
  for (const [kind, constructor] of Object.entries(terminalErrors)) {
    if (error instanceof constructor) return { kind: kind as AboutTerminalOutcome['kind'], message: error.message };
  }
  return null;
}
function terminalError(outcome: AboutTerminalOutcome): Error {
  if (outcome.kind === 'target-not-bound') return new TargetNotBound();
  if (outcome.kind === 'target-unavailable') return new TargetUnavailable();
  return new terminalErrors[outcome.kind](outcome.message);
}

export interface RealmAboutPostInput {
  profile: 'realm-about-post-v1'; about: string; targetRevision: string;
  zone: string; path: string; routeRevision: string; actingSubject: string;
  language: string; direction: 'ltr' | 'rtl' | 'none'; spoiler?: boolean;
  body?: string; document?: DocumentSnapshot;
}

/** The command owns sequencing only. Account, Access, Content and the graph
 * retain their existing authority, admission, CAS and immutable receipt owners. */
export class RealmAboutPostCommand {
  private readonly store: RealmAboutThreadStore;
  constructor(private readonly work: MainWorkDependencies) {
    if (!work.realmReplyThreads || !work.realmReplies || !work.contentAuthoring) {
      throw new RealmReplyUnavailable('Realm discussion posting is unavailable');
    }
    this.store = new RealmAboutThreadStore(work.realmReplyThreads.rankingContent);
  }

  private async basis(request: Request, principal: VerifiedPrincipal, realm: string, input: RealmAboutPostInput) {
    const route = await resolveZoneRoute(this.work, request, {
      zone: input.zone, path: input.path, actingSubject: input.actingSubject,
    }).catch(error => {
      if (error instanceof ZoneRouteMissing) throw new WorkReadMissing('Zone route is unavailable');
      throw error;
    });
    const resource = route.kind === 'home' ? route.page?.reference.resourceId
      : route.kind === 'document' || route.kind === 'detail' ? route.resource.id : undefined;
    const current = await readZoneConfiguration(this.work.environment, input.zone);
    const policy = await workRead(this.work, request, { actingSubject: input.actingSubject }, async session => {
      const policy = await session.realm(realm);
      const [target] = await resolveTargets(session, [input.about], 'discussion');
      if (target!.revision !== input.targetRevision) throw new WorkReadMoved('Discussion target changed');
      return policy;
    });
    // Disclose identifiers before comparing route coordinates: an unavailable
    // target is the same 404 whether it exists or not.
    if (route.revision !== input.routeRevision || route.realm !== realm
      || current.configuration.defaultRealm !== realm || resource !== input.about) {
      throw new WorkReadMoved('Zone discussion basis changed');
    }
    if (!this.work.access.withRealmPolicy) throw new RealmReplyUnavailable('Realm policy owner is unavailable');
    await this.work.access.withRealmPolicy(principal, input.actingSubject, realm, 'reply', async permit => {
      if (policy.visibility !== 'public' && !permit.member) throw new WorkReadMissing('Realm is unavailable');
      if (policy.reviewMode === 'mandatory' || policy.reviewMode === 'trusted-members' && !permit.member) {
        throw new RealmReplyDenied('Realm policy requires moderator approval');
      }
    });
    return { zone: input.zone, zoneRevision: current.revision, routeRevision: route.revision };
  }

  private parentReader(selected: AboutPostOperation): CanonicalReplyParentReader {
    return {
      // A newly selected opener is not its own parent. The unique-key owner
      // already allocated it before the bridge inserts its immutable identity.
      opener: async (realm, about) => {
        const canonical = await this.store.readThread(realm, about);
        if (!canonical || canonical.openerReply !== selected.openerReply
          || canonical.rootRevision !== selected.rootRevision) throw new RealmReplyStale('Discussion selection changed');
        return selected.parentReply === null ? null : { realm, about, reply: canonical.openerReply,
          rootRevision: canonical.rootRevision, originRealm: realm };
      },
      visibleParent: async (realm, reply) => {
        // This internal bridge consumes the canonical owner's immutable,
        // posted selection, including a withheld opener. No parent coordinates
        // enter the posting receipt; read disclosure never reallocates the key.
        if (realm !== selected.realm || reply !== selected.parentReply || !selected.parentRevision) {
          throw new RealmReplyStale('Discussion parent selection changed');
        }
        return { revisionId: selected.parentRevision };
      },
    };
  }

  private async posted(selected: AboutPostOperation) {
    if (!selected.placementOperationId || !selected.revisionId) throw new RealmReplyUnavailable('Discussion placement is pending');
    const receipt = await readReplyGraphReceipt(this.work.environment, { id: selected.placementOperationId, action: 'reply.place' });
    if (receipt?.outcome !== 'succeeded' || receipt.receipt !== selected.placementReceipt
      || receipt.realm !== selected.realm || receipt.reply !== selected.reply
      || receipt.revisionId !== selected.revisionId || !receipt.placement) {
      throw new RealmReplyUnavailable('Discussion placement receipt is unavailable');
    }
    return { profile: 'realm-about-post-v1' as const, realm: selected.realm, about: selected.about,
      author: selected.actor, reply: selected.reply, revisionId: selected.revisionId, placement: receipt.placement };
  }

  async post(request: Request, principal: VerifiedPrincipal, realm: string, input: RealmAboutPostInput, key: string) {
    const principalKey = JSON.stringify([principal.issuer, principal.subject]);
    const digest = realmReplyDigest({ realm, input });
    let selected = await this.store.readIntent(principalKey, key, digest);
    // Exact successful replay consumes receipts, never a newer route/target cut.
    if (selected?.phase === 'posted') return { status: 200 as const, body: await this.posted(selected) };
    if (selected?.terminalOutcome) throw terminalError(selected.terminalOutcome);
    let draftAdmission: RegisteredAdmission | undefined;
    type Stage = 'basis' | 'draft' | 'identity' | 'admission' | 'dispatch' | 'placement' | 'receipt';
    let stage: Stage = 'receipt';
    const currentStage = (): Stage => stage;
    try {
      const phaseKey = (phase: string) => `about-post:${selected!.id}:${phase}`;
      const place = async (draft: { revisionId: string; revisionDigest: string },
        basis: NonNullable<AboutPostOperation['dispatchBasis']>, replay: boolean) => {
        const placement = { realm, reply: selected!.reply, revisionId: draft.revisionId,
          revisionDigest: draft.revisionDigest, reviewDecisionId: null, expectedHead: null };
        stage = 'admission';
        const admission = await this.work.access.register({ principal, actingSubject: input.actingSubject,
          action: 'reply.place', scope: `reply:place:${realm}`, idempotencyKey: phaseKey('placement'),
          requestDigest: realmReplyDigest(placement) });
        stage = 'dispatch';
        selected = await this.store.recordDispatch(selected!.id, admission.id, basis);
        if (selected.terminalOutcome) throw terminalError(selected.terminalOutcome);
        if (selected.phase === 'posted') return { status: 200 as const, body: await this.posted(selected) };
        basis = selected.dispatchBasis!;
        replay ||= selected.replayed;
        stage = 'placement';
        try {
          await this.work.realmReplies!.place(principal, input.actingSubject, placement,
            phaseKey('placement'), realmReplyDigest(placement), basis);
        } catch (error) {
          const terminal = await readReplyGraphReceipt(this.work.environment, admission);
          if (terminal?.outcome === 'cancelled') {
            const outcome = terminalOutcome(error, 'placement');
            if (!outcome) throw new RealmReplyUnavailable('Discussion cancellation recovery is pending');
            selected = await this.store.recordCancellation(selected!.id, terminal, outcome);
            throw terminalError(selected.terminalOutcome!);
          } else {
            // Unknown outcomes and graph winners remain recoverable when
            // settlement returns a refusal. The composer must keep the same intent, rather than
            // treating a committed post as a terminal pre-placement failure.
            throw new RealmReplyUnavailable('Discussion placement settlement is pending');
          }
        }
        stage = 'receipt';
        const receipt = await readReplyGraphReceipt(this.work.environment, admission);
        if (receipt?.outcome !== 'succeeded' || receipt.realm !== realm || receipt.reply !== selected.reply
          || receipt.revisionId !== draft.revisionId) throw new RealmReplyUnavailable('Discussion placement is pending');
        selected = await this.store.recordPosted(selected.id, admission.id, receipt.receipt);
        return { status: replay ? 200 as const : 201 as const, body: await this.posted(selected) };
      };
      // Recover the graph owner's outcome before current authority, target or
      // route checks. Success and cancellation finish native settlement under
      // the retained admission; this intent allocates no fresh key or opener.
      if (selected?.placementAdmissionId && selected.dispatchBasis) {
        const draft = await this.store.savedDraft(selected);
        if (!draft) throw new RealmReplyUnavailable('Discussion draft receipt is unavailable');
        // The native placement owner consumes success or cancellation and
        // finishes settlement/sealing before emitting a terminal response.
        // A graph cancellation alone does not prove cleanup has finished.
        return await place(draft, selected.dispatchBasis, true);
      }
      try {
        if (input.language.length > 35 || !parseLanguage(input.language)) throw new Error('invalid language');
        const authored = authoredDocumentBody(input, 8192);
        if (authored.document ? !hasDocumentContent(authored.document) : !authored.body) {
          throw new Error('empty discussion post');
        }
      } catch { throw new RealmReplyInvalid('Invalid discussion post content'); }
      stage = 'basis';
      await this.basis(request, principal, realm, input);
      if (!this.work.access.assertAuthority) throw new RealmReplyUnavailable('Posting authority owner is unavailable');
      // Refuse ineligible authors before allocating a canonical reservation.
      // These read-only Access probes retain exactly the three effect owners' policy.
      for (const request of selected ? [] : [
        { action: 'content.draft', scope: `content:draft:https://rezics.com/id/${randomUUID()}`,
          baselineRelatedWork: input.about, baselineSourceRevision: input.targetRevision },
        { action: 'reply.create', scope: `reply:create:${input.about}`, baselineSourceRevision: input.targetRevision },
        { action: 'reply.place', scope: `reply:place:${realm}` },
      ]) {
        await this.work.access.assertAuthority({ ...request, principal, actingSubject: input.actingSubject });
      }
      const canonical = await this.store.readThread(realm, input.about);
      if (canonical?.state === 'reserved') {
        const opening = await this.store.openingPlacement(canonical);
        const terminal = opening ? await readReplyGraphReceipt(this.work.environment, { id: opening, action: 'reply.place' }) : null;
        if (terminal?.outcome === 'cancelled') await this.store.releaseReservation(canonical, terminal);
      }
      selected = selected ? await this.store.resume(selected.id) : await this.store.reserve({ realm,
        about: input.about, actor: input.actingSubject, intentKey: key, intentDigest: digest,
        rootRevision: input.targetRevision }, principalKey);
      if (selected.pending) {
        const opening = await this.store.openingPlacement(selected);
        if (opening && (await readReplyGraphReceipt(this.work.environment,
          { id: opening, action: 'reply.place' }))?.outcome === 'cancelled') {
          throw new RealmReplyStale('Discussion opener operation was cancelled');
        }
        return { status: 202 as const, body: { operationId: selected.id } };
      }
      let draft = await this.store.savedDraft(selected);
      if (!draft) {
        let saved: CanonicalAboutReplyDraftResult;
        stage = 'draft';
        try {
          // Capture the bridge's existing admission without reconstructing its
          // command or author policy. Its immutable Content cancellation binds
          // ContentConflict to this exact draft rather than to an HTTP status.
          const draftAccess = new Proxy(this.work.access, {
            get: (target, property) => {
              if (property === 'register') return async (...args: Parameters<typeof target.register>) => {
                const admitted = await target.register(...args);
                if (admitted.action !== 'content.draft' || admitted.scope !== `content:draft:${selected!.reply}`
                  || admitted.actingSubject !== selected!.actor || admitted.requestDigest !== args[0].requestDigest) {
                  throw new RealmReplyUnavailable('Discussion draft admission differs');
                }
                draftAdmission = admitted;
                return admitted;
              };
              const value = Reflect.get(target, property, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
          saved = await saveVerifiedMemberReplyDraft(this.work.environment, this.work.contentAuthoring!,
            draftAccess, principal, { kind: 'canonical-about-reply', parentReader: this.parentReader(selected),
              input: { reply: selected.reply, variantId: selected.variantId, expectedHead: null,
                about: input.about, realm, targetRevision: input.targetRevision, originRealm: realm,
                language: input.language, direction: input.direction, actingSubject: input.actingSubject,
                ...(input.body !== undefined ? { body: input.body } : { document: input.document! }),
                ...(input.spoiler !== undefined ? { spoiler: input.spoiler } : {}) } }, phaseKey('draft')) as CanonicalAboutReplyDraftResult;
        } catch (error) {
          // If transport failed after Content committed, retain that transition.
          // The immutable owner receipt remains the recovery source of truth.
          await this.store.savedDraft(selected);
          throw error;
        }
        stage = 'receipt';
        if (saved.rootRevision !== selected.rootRevision || (saved.canonicalParent?.reply ?? null) !== selected.parentReply
          || (saved.canonicalParent?.parentRevision ?? null) !== selected.parentRevision) {
          throw new RealmReplyUnavailable('Discussion draft selection differs from its owner receipt');
        }
        selected = await this.store.recordDraftRevision(selected.id, saved.revisionId);
        draft = saved;
      }
      selected = await this.store.resume(selected.id);
      stage = 'basis';
      await this.basis(request, principal, realm, input);
      const identity = { reply: selected.reply, variantId: selected.variantId, revisionId: draft.revisionId,
        author: input.actingSubject, rootTarget: input.about, rootRevision: selected.rootRevision,
        parentReply: selected.parentReply, parentRevision: selected.parentRevision, contextRevision: null, originRealm: realm,
        ...(input.spoiler !== undefined ? { spoiler: input.spoiler } : {}) };
      if (selected.phase === 'drafted') {
        stage = 'identity';
        await this.work.realmReplies!.create(principal, identity, phaseKey('identity'), realmReplyDigest(identity));
        stage = 'receipt';
        selected = await this.store.resume(selected.id);
      }
      stage = 'basis';
      const basis = await this.basis(request, principal, realm, input);
      return await place(draft, basis, false);
    } catch (error) {
      // A concurrent terminal transition is immutable even if this request was
      // still reading a draft or recording dispatch on its older selection.
      const retained = await this.store.readIntent(principalKey, key, digest);
      if (retained?.terminalOutcome) throw terminalError(retained.terminalOutcome);
      const failedStage = currentStage();
      // Error classes carry the existing owners' definite refusals. Receipt
      // corruption/conflict, missing responses and owner outages are uncertain
      // and retain the selection. An HTTP status is never terminal evidence.
      const cancelledDraft = failedStage === 'draft' && error instanceof ContentConflict && draftAdmission
        ? await this.store.draftWasCancelled(draftAdmission.id, draftAdmission.requestDigest) : false;
      const basisRefusal = error instanceof WorkReadMoved || error instanceof WorkReadMissing
        || error instanceof WorkReadInvalid || error instanceof TargetNotBound;
      const terminal = cancelledDraft || error instanceof RealmReplyStale
        || ['basis', 'draft', 'identity'].includes(failedStage) && basisRefusal
        || failedStage === 'basis' && (error instanceof RealmReplyDenied || error instanceof AdmissionDenied || error instanceof AdmissionExpired)
        || failedStage === 'draft' && (error instanceof ContentDraftDenied || error instanceof ContentDraftStale
          || error instanceof AdmissionDenied || error instanceof AdmissionExpired)
        || failedStage === 'identity' && (error instanceof RealmReplyDenied || error instanceof RealmReplyInvalid
          || error instanceof RealmReplyStale || error instanceof AdmissionDenied || error instanceof AdmissionExpired)
        || failedStage === 'admission' && (error instanceof AdmissionDenied || error instanceof AdmissionExpired);
      if (terminal) {
        const outcome = terminalOutcome(error, 'pre-dispatch');
        if (!outcome) throw new RealmReplyUnavailable('Discussion refusal recovery is pending');
        const current = await this.store.refuseIntent(principalKey, key, digest, outcome);
        if (current.kind === 'posted') return { status: 200 as const, body: await this.posted(current.operation) };
        if (current.kind === 'absent' && !selected) {
          // No selection means this request rejected before owner effects.
          // This ordinary answer does not settle the key: another request can
          // still allocate it. The locked owner check above preserves a raced
          // selection's refusal, dispatch recovery or committed success.
          throw terminalError(outcome);
        }
        if (current.kind === 'recoverable' || current.kind === 'absent') {
          throw new RealmReplyUnavailable('Discussion dispatch recovery is pending');
        }
        if (current.kind === 'refused') throw terminalError(current.operation.terminalOutcome!);
      }
      if (selected && (error instanceof ContentConflict && !cancelledDraft
        || error instanceof WorkReadLimit || error instanceof AdmissionConflict
        || error instanceof RealmReplyConflict)) {
        throw new RealmReplyUnavailable('Discussion owner receipt recovery is pending');
      }
      throw error;
    }
  }
}
