import { createHash } from 'node:crypto';
import type { ContentCore } from '../../../../content/src/core.ts';
import type { AccessAdmissionRegistry, RegisteredAdmission, VerifiedPrincipal } from '../access/admission.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { RealmReplyDenied, RealmReplyInvalid, RealmReplyStale, RealmReplyUnavailable, type PlacementInput,
  type ReplyIdentityInput, type ReviewInput, RealmReplyContentStore } from './content-store.ts';
import { acknowledgeContentDecision, cancelPlacement, placeReply,
  readPlacementHead, readRootPlacementHeads,
  readReplyGraphReceipt } from './graph.ts';
import { publicReplyRoot } from './root.ts';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function realmReplyDigest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

/** Content owns identities and exact review; Jena owns Realm-local placement. */
export class RealmReplyStore {
  constructor(private readonly content: RealmReplyContentStore,
    private readonly contentCore: Pick<ContentCore, 'settlePublication'>,
    private readonly access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
    private readonly env: WorkActivationEnvironment) {}

  private async admission(principal: VerifiedPrincipal, actingSubject: string, action: string,
    scope: string, key: string, requestDigest: string, sourceRevision?: string): Promise<RegisteredAdmission> {
    await assertGraphAdmissionOpen(this.env.fuseki, this.env.lineage);
    const registered = await this.access.register({ principal, actingSubject, action, scope,
      idempotencyKey: key, requestDigest, baselineSourceRevision: sourceRevision });
    const contentAction = action === 'reply.place' ? 'publication.prepare' : action;
    const saved = await this.content.hasReceipt(registered.id, contentAction, requestDigest);
    if (registered.state === 'sealed') {
      if (!saved) throw new RealmReplyUnavailable('sealed admission lost its Content receipt');
      return registered;
    }
    const prior = await readReplyGraphReceipt(this.env, registered);
    if (prior) return registered;
    if (saved && registered.state === 'claimed') return registered;
    if (!registered.dispatchEligible) throw new RealmReplyUnavailable('admission dispatch is fenced');
    return this.access.claim(registered.id, requestDigest, principal);
  }

  private async seal(admission: RegisteredAdmission): Promise<void> {
    const terminal = await readReplyGraphReceipt(this.env, admission);
    if (!terminal) throw new RealmReplyUnavailable('terminal graph receipt is unavailable');
    await this.access.recordGraphOutcome(admission.id, terminal);
  }

  async create(principal: VerifiedPrincipal, input: ReplyIdentityInput,
    key: string, digest: string) {
    const admission = await this.admission(principal, input.author, 'reply.create',
      `reply:create:${input.rootTarget}`, key, digest, input.rootRevision);
    let result;
    try { result = await this.content.createReply(admission, input); }
    catch (error) {
      if (error instanceof RealmReplyDenied || error instanceof RealmReplyInvalid || error instanceof RealmReplyStale) {
        const succeeded = await this.content.cancelCreate(admission);
        if (succeeded) await acknowledgeContentDecision(this.env, admission);
        else await cancelPlacement(this.env, admission);
        await this.seal(admission);
      }
      throw error;
    }
    await acknowledgeContentDecision(this.env, admission);
    await this.seal(admission);
    return result;
  }

  async review(principal: VerifiedPrincipal, actingSubject: string, input: ReviewInput,
    key: string, digest: string) {
    const admission = await this.admission(principal, actingSubject, 'review.decide',
      `review:decide:${input.realm}`, key, digest);
    const result = await this.content.decideReview(admission, input);
    await acknowledgeContentDecision(this.env, admission);
    await this.seal(admission);
    return result;
  }

  async place(principal: VerifiedPrincipal, actingSubject: string, input: PlacementInput,
    key: string, digest: string) {
    const admission = await this.admission(principal, actingSubject, 'reply.place',
      `reply:place:${input.realm}`, key, digest);
    const prepared = await this.content.preparePlacement(admission, input);
    let terminal = await readReplyGraphReceipt(this.env, admission);
    if (!terminal) {
      // A previous attempt can leave the pin while its graph result is unknown.
      // The immutable receipt resolves that ambiguity before another dispatch.
      try { terminal = await placeReply(this.env, admission, prepared, input.expectedHead); }
      catch (error) {
        if (!(error instanceof RealmReplyStale)) throw error;
        terminal = await cancelPlacement(this.env, admission);
      }
    }
    if (terminal.outcome === 'cancelled') {
      await this.contentCore.settlePublication(`${admission.id}:settle`, admission.id, {
        outcome: 'rejected', revisionId: input.revisionId, receipt: terminal.receipt,
        dataEpoch: terminal.dataEpoch, sequence: terminal.sequence,
      });
      await this.seal(admission);
      throw new RealmReplyStale('Realm reply placement was cancelled');
    }
    if (!terminal.placement
      || terminal.realm !== input.realm || terminal.reply !== input.reply
      || terminal.revisionId !== input.revisionId) {
      throw new RealmReplyStale('placement did not accept the reviewed revision');
    }
    await this.contentCore.settlePublication(`${admission.id}:settle`, admission.id, {
      outcome: 'active', revisionId: input.revisionId, receipt: terminal.receipt,
      dataEpoch: terminal.dataEpoch, sequence: terminal.sequence,
    });
    await this.seal(admission);
    return { placement: terminal.placement, reply: input.reply, realm: input.realm,
      revisionId: input.revisionId, reviewDecisionId: input.reviewDecisionId,
      replayed: admission.replayed || prepared.replayed };
  }

  async visible(realm: string, reply: string) {
    await assertGraphAdmissionOpen(this.env.fuseki, this.env.lineage);
    const placement = await readPlacementHead(this.env, realm, reply);
    if (!placement) return null;
    if (!await this.content.currentReview(realm, reply, placement.revisionId,
      placement.reviewDecisionId, placement.preparationId)) return null;
    return placement;
  }

  async readPublic(reply: string) {
    await assertGraphAdmissionOpen(this.env.fuseki, this.env.lineage);
    const result = await this.content.readCurrent(reply);
    if (!result || !await publicReplyRoot(this.env.fuseki, result.rootTarget, result.rootRevision)) return null;
    return result;
  }

  async listPublic(rootTarget: string, rootRevision: string, after?: string) {
    await assertGraphAdmissionOpen(this.env.fuseki, this.env.lineage);
    if (!await publicReplyRoot(this.env.fuseki, rootTarget, rootRevision)) return null;
    const page = await this.content.listCurrent(rootTarget, rootRevision, after);
    if (!await publicReplyRoot(this.env.fuseki, rootTarget, rootRevision)) return null;
    return page;
  }

  async rootCount(realm: string, rootTarget: string) {
    await assertGraphAdmissionOpen(this.env.fuseki, this.env.lineage);
    const page = await readRootPlacementHeads(this.env, realm, rootTarget);
    let count = 0;
    for (const placement of page.heads) {
      if (await this.content.currentReview(realm, placement.reply, placement.revisionId,
        placement.reviewDecisionId, placement.preparationId)) count++;
    }
    return { realm, rootTarget, count, complete: page.complete };
  }
}
