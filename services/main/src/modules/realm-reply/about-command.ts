import { randomUUID } from 'node:crypto';
import { ContentConflict } from '../../../../content/src/core.ts';
import { hasDocumentContent, type DocumentSnapshot } from '@rezics/document';
import { authoredDocumentBody } from '../../../../content/src/document-body.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { AdmissionConflict, AdmissionDenied, AdmissionExpired, type RegisteredAdmission, type VerifiedPrincipal } from '../access/admission.ts';
import { ContentDraftDenied, ContentDraftStale } from '../content-publication/draft.ts';
import { saveVerifiedMemberReplyDraft, type CanonicalAboutReplyDraftResult } from '../content-publication/reply-draft.ts';
import { resolveTargets, TargetNotBound } from '../target/resolve.ts';
import { workRead, WorkReadInvalid, WorkReadLimit, WorkReadMissing, WorkReadMoved } from '../work/read-session.ts';
import { parseLanguage } from '../display-language/tag.ts';
import { resolveZoneRoute, ZoneRouteMissing } from '../zone/route.ts';
import { readZoneConfiguration } from '../zone/configuration.ts';
import { RealmAboutThreadStore, type AboutPostOperation } from './about-store.ts';
import { RealmReplyConflict, RealmReplyDenied, RealmReplyInvalid, RealmReplyStale, RealmReplyUnavailable } from './content-store.ts';
import { readReplyGraphReceipt } from './graph.ts';
import { realmReplyDigest } from './store.ts';
import type { CanonicalReplyParentReader } from './root.ts';

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
    if (selected?.terminalRefusal) throw new RealmReplyStale('Discussion intent was refused before placement');
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
        stage = 'placement';
        try {
          await this.work.realmReplies!.place(principal, input.actingSubject, placement,
            phaseKey('placement'), realmReplyDigest(placement), basis);
        } catch (error) {
          const terminal = await readReplyGraphReceipt(this.work.environment, admission);
          if (terminal?.outcome === 'cancelled') await this.store.releaseReservation(selected!, terminal);
          else {
            // Unknown outcomes and graph winners remain recoverable when
            // settlement returns a refusal. The composer must keep the same intent, rather than
            // treating a committed post as a terminal pre-placement failure.
            throw new RealmReplyUnavailable('Discussion placement settlement is pending');
          }
          throw error;
        }
        stage = 'receipt';
        const receipt = await readReplyGraphReceipt(this.work.environment, admission);
        if (receipt?.outcome !== 'succeeded' || receipt.realm !== realm || receipt.reply !== selected.reply
          || receipt.revisionId !== draft.revisionId) throw new RealmReplyUnavailable('Discussion placement is pending');
        selected = await this.store.recordPosted(selected.id, admission.id, receipt.receipt);
        return { status: replay ? 200 as const : 201 as const, body: await this.posted(selected) };
      };
      // The graph receipt decides a committed winner before current authority,
      // target or route checks. Recover settlement under the same admission; a
      // cancellation also stays terminal. No fresh key or opener is allocated.
      if (selected?.placementAdmissionId && selected.dispatchBasis) {
        const receipt = await readReplyGraphReceipt(this.work.environment,
          { id: selected.placementAdmissionId, action: 'reply.place' });
        if (receipt?.outcome === 'cancelled') {
          await this.store.releaseReservation(selected, receipt);
          throw new RealmReplyStale('Discussion placement was cancelled');
        }
        const draft = await this.store.savedDraft(selected);
        if (!draft) throw new RealmReplyUnavailable('Discussion draft receipt is unavailable');
        // Even before a graph receipt exists, the recorded dispatch belongs to
        // the native placement owner. It decides cancellation versus a winner
        // on this retained basis; a newer route must not strand the admission.
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
      const failedStage = currentStage();
      // Error classes carry the existing owners' definite refusals. Receipt
      // corruption/conflict, missing responses and owner outages are uncertain
      // and retain the selection. An HTTP status is never terminal evidence.
      const cancelledDraft = failedStage === 'draft' && error instanceof ContentConflict && draftAdmission
        ? await this.store.draftWasCancelled(draftAdmission.id, draftAdmission.requestDigest) : false;
      const basisRefusal = error instanceof WorkReadMoved || error instanceof WorkReadMissing
        || error instanceof WorkReadInvalid || error instanceof TargetNotBound;
      const terminal = cancelledDraft
        || ['basis', 'draft', 'identity'].includes(failedStage) && basisRefusal
        || failedStage === 'basis' && (error instanceof RealmReplyDenied || error instanceof AdmissionDenied || error instanceof AdmissionExpired)
        || failedStage === 'draft' && (error instanceof ContentDraftDenied || error instanceof ContentDraftStale
          || error instanceof AdmissionDenied || error instanceof AdmissionExpired)
        || failedStage === 'identity' && (error instanceof RealmReplyDenied || error instanceof RealmReplyInvalid
          || error instanceof RealmReplyStale || error instanceof AdmissionDenied || error instanceof AdmissionExpired)
        || failedStage === 'admission' && (error instanceof AdmissionDenied || error instanceof AdmissionExpired);
      if (selected && terminal) {
        const refused = await this.store.refuseBeforeDispatch(selected.id);
        if (!refused && selected.placementAdmissionId) {
          throw new RealmReplyUnavailable('Discussion dispatch recovery is pending');
        }
      }
      if (selected && (error instanceof ContentConflict && !cancelledDraft
        || error instanceof WorkReadLimit || error instanceof AdmissionConflict
        || error instanceof RealmReplyConflict)) {
        throw new RealmReplyUnavailable('Discussion owner receipt recovery is pending');
      }
      if (terminal && error instanceof AdmissionExpired) throw new RealmReplyStale('Discussion admission expired');
      throw error;
    }
  }
}
