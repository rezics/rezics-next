import { readCurrentProfile } from '../realm-profile/commands.ts';
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
import { readableReplyRoot, replyRoot } from './root.ts';
import { targetRead } from '../target/resolve.ts';
import { WorkReadMissing } from '../work/read-session.ts';
import { readRealmPolicy, reviewPolicy } from '../space/policy.ts';
import type { RealmPermit } from '../access/realm-management-policy.ts';
import { discloseInventory } from '../disclosure/read.ts';
import { disclosureViewer } from '../disclosure/viewer.ts';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function realmReplyDigest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

type RealmReadAuthority = Partial<Pick<AccessAdmissionRegistry, 'realmReadProof' | 'canReadWork'
  | 'canReadSemanticResource'>>;

async function realmReplyReadProof(access: RealmReadAuthority, env: WorkActivationEnvironment,
  realm: string, principal?: VerifiedPrincipal, actor?: string): Promise<string | null> {
  const policy = await readRealmPolicy(env, realm);
  if (!policy) return null;
  const member = policy.visibility === 'private'
    ? principal && actor ? await access.realmReadProof?.(principal, actor, realm) : null : 'public';
  return member ? JSON.stringify([policy, member]) : null;
}

/** The same exact placement, Content review and two-sided Realm fence serve direct reads and notifications. */
export async function visibleRealmReply(content: Pick<RealmReplyContentStore, 'origin' | 'currentReview'>,
  access: RealmReadAuthority, env: WorkActivationEnvironment, realm: string, reply: string,
  principal?: VerifiedPrincipal, actor?: string) {
  const before = await realmReplyReadProof(access, env, realm, principal, actor);
  if (!before) return null;
  const origin = await content.origin(reply);
  if (origin?.realm && origin.realm !== realm) return null;
  const placement = await readPlacementHead(env, realm, reply);
  if (!placement) return null;
  if (!await content.currentReview(realm, reply, placement.revisionId,
    placement.reviewDecisionId, placement.preparationId)) return null;
  return await realmReplyReadProof(access, env, realm, principal, actor) === before ? placement : null;
}

/** Content owns identities and exact review; Jena owns Realm-local placement. */
export class RealmReplyStore {
  constructor(private readonly content: RealmReplyContentStore,
    private readonly contentCore: Pick<ContentCore, 'settlePublication'>,
    private readonly access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>
      & Partial<Pick<AccessAdmissionRegistry, 'hasRealmMemberAdmission' | 'withRealmPolicy' | 'realmReadProof'
        | 'canReadWork' | 'canReadSemanticResource'>>,
    private readonly env: WorkActivationEnvironment) {}

  private async admission(principal: VerifiedPrincipal, actingSubject: string, action: string,
    scope: string, key: string, requestDigest: string, sourceRevision?: string): Promise<RegisteredAdmission> {
    await assertGraphAdmissionOpen(this.env.fuseki, this.env.lineage);
    const registered = await this.access.register({ principal, actingSubject, action, scope,
      idempotencyKey: key, requestDigest, baselineSourceRevision: sourceRevision });
    const contentAction = action === 'reply.place' ? 'publication.prepare' : action;
    const saved = await this.content.hasReceipt(registered.id, contentAction, requestDigest);
    if (registered.state === 'sealed') {
      const terminal = await readReplyGraphReceipt(this.env, registered);
      if (terminal?.outcome === 'cancelled') return registered;
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
    const origin = await this.content.origin(input.reply);
    if (origin?.realm) {
      if (!this.access.withRealmPolicy) throw new RealmReplyUnavailable('Realm policy owner is unavailable');
      return this.access.withRealmPolicy(principal, input.author, origin.realm, 'reply', async permit => {
        const policy = await readRealmPolicy(this.env, origin.realm!);
        if (!policy || policy.visibility !== 'public' && !permit.member) throw new RealmReplyDenied('Realm membership is required');
        return this.createAdmitted(principal, input, key, digest);
      });
    }
    return this.createAdmitted(principal, input, key, digest);
  }

  private async createAdmitted(principal: VerifiedPrincipal, input: ReplyIdentityInput, key: string, digest: string) {
    const admission = await this.admission(principal, input.author, 'reply.create',
      `reply:create:${input.rootTarget}`, key, digest, input.rootRevision);
    let result;
    try {
      // A lost-response retry retains its successful identity after a target edit.
      // Only a new Content identity must bind to the target's current root.
      if (!await this.content.hasReceipt(admission.id, 'reply.create', digest)) {
        const currentRoot = await targetRead(this.env, { access: this.access, principal, actingSubject: input.author },
          session => replyRoot(session, input.rootTarget, input.rootRevision));
        if (!currentRoot) throw new RealmReplyDenied('Reply root is unavailable');
      }
      result = await this.content.createReply(admission, input);
    }
    catch (error) {
      if (error instanceof WorkReadMissing) error = new RealmReplyDenied('Reply root is unavailable');
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
    if (this.access.withRealmPolicy) return this.access.withRealmPolicy(principal, actingSubject, input.realm, 'reply',
      permit => this.placeAdmitted(principal, actingSubject, input, key, digest, permit));
    return this.placeAdmitted(principal, actingSubject, input, key, digest);
  }

  private async placeAdmitted(principal: VerifiedPrincipal, actingSubject: string, input: PlacementInput,
    key: string, digest: string, permit?: RealmPermit) {
    const unified = await readRealmPolicy(this.env, input.realm);
    if (permit && (!unified || unified.visibility !== 'public' && !permit.member)) {
      throw new RealmReplyDenied('Realm membership is required');
    }
    const admission = await this.admission(principal, actingSubject, 'reply.place',
      `reply:place:${input.realm}`, key, digest);
    const existing = await readReplyGraphReceipt(this.env, admission);
    if (existing?.outcome === 'cancelled') throw new RealmReplyStale('Realm reply placement was cancelled');
    let prepared = await this.content.readPlacement(admission.id);
    if (!prepared) {
      try {
        let directPolicyRevision: string | undefined;
        let directPolicy: string | undefined;
        if (input.reviewDecisionId === null) {
          if (unified?.revision) {
            if (unified.revision !== permit?.revision || unified.reviewMode === 'mandatory'
              || unified.reviewMode === 'trusted-members' && !permit.member) {
              throw new RealmReplyDenied('Realm policy requires moderator approval');
            }
            directPolicyRevision = unified.revision;
            directPolicy = reviewPolicy(unified.reviewMode);
          } else {
            const policy = await readCurrentProfile(this.env, input.realm);
            if (policy?.profile.replyPolicy !== 'members-direct'
              || !await this.access.hasRealmMemberAdmission?.(admission.id)) {
              throw new RealmReplyDenied('Realm policy requires moderator approval');
            }
            directPolicyRevision = policy.revision;
          }
        }
        prepared = await this.content.preparePlacement(admission, input, directPolicyRevision, directPolicy);
      } catch (error) {
        if (error instanceof RealmReplyDenied || error instanceof RealmReplyInvalid || error instanceof RealmReplyStale) {
          await cancelPlacement(this.env, admission);
          await this.seal(admission);
        }
        throw error;
      }
    }
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
      revisionId: input.revisionId, reviewDecisionId: prepared.reviewDecisionId, reviewGeneration: prepared.reviewGeneration,
      replayed: admission.replayed || prepared.replayed };
  }

  async visible(realm: string, reply: string, principal?: VerifiedPrincipal, actor?: string) {
    return visibleRealmReply(this.content, this.access, this.env, realm, reply, principal, actor);
  }

  private async assemblePublic(reply: string, principal?: VerifiedPrincipal, actor?: string) {
    await assertGraphAdmissionOpen(this.env.fuseki, this.env.lineage);
    const result = await this.content.readCurrent(reply);
    if (!result || !await readableReplyRoot(this.env, result.rootTarget, result.rootRevision,
      this.access, principal ?? null, actor)) return null;
    if (result.originRealm) {
      const visible = await this.visible(result.originRealm, reply, principal, actor);
      if (visible?.revisionId !== result.revisionId) return null;
    }
    return result;
  }

  /** Profile pages share one final audience batch for their eight candidates. */
  async readPublicBatch(replies: readonly string[], principal?: VerifiedPrincipal, actor?: string) {
    if (replies.length > 32) throw new RealmReplyInvalid('Reply read exceeds its bound');
    const results = await Promise.all(replies.map(reply => this.assemblePublic(reply, principal, actor)));
    const available = results.flatMap((result, index) => result ? [{ result, index }] : []);
    const decisions = await discloseInventory(this.env, available.map(({ result, index }) => ({
      owner: 'content' as const, resource: replies[index]!, component: 'body' as const,
      revision: result.revisionId, work: result.rootTarget, context: result.originRealm ?? undefined,
    })), disclosureViewer(principal ?? null), 'read');
    for (const [ordinal, { index }] of available.entries()) if (decisions[ordinal] !== 'visible') results[index] = null;
    return results;
  }

  async readPublic(reply: string, principal?: VerifiedPrincipal, actor?: string) {
    return (await this.readPublicBatch([reply], principal, actor))[0] ?? null;
  }

  /** An explicit Realm selects its origin partition before LIMIT. Independent
   * public replies have a null origin, so private rows cannot alter their pages.
   * At most 32 exact placement/review checks and two policy fences per page. */
  async listPublic(rootTarget: string, rootRevision: string, after?: string, realm?: string,
    principal?: VerifiedPrincipal, actor?: string) {
    await assertGraphAdmissionOpen(this.env.fuseki, this.env.lineage);
    if (!await readableReplyRoot(this.env, rootTarget, rootRevision, this.access, principal ?? null, actor)) return null;
    const before = realm ? await realmReplyReadProof(this.access, this.env, realm, principal, actor) : 'public';
    if (!before) return null;
    const page = await this.content.listCurrent(rootTarget, rootRevision, after, realm ?? null);
    if (realm) {
      const visible = await Promise.all(page.items.map(async item =>
        (await this.visible(realm, item.reply as string, principal, actor))?.revisionId === item.revisionId));
      page.items = page.items.filter((_item, index) => visible[index]);
      if (await realmReplyReadProof(this.access, this.env, realm, principal, actor) !== before) return null;
    }
    if (!await readableReplyRoot(this.env, rootTarget, rootRevision, this.access, principal ?? null, actor)) return null;
    const decisions = await discloseInventory(this.env, page.items.map(item => ({ owner: 'content' as const,
      resource: item.reply, component: 'body' as const, revision: item.revisionId,
      work: rootTarget, context: realm })), disclosureViewer(principal ?? null), 'thread');
    page.items = page.items.filter((_item, index) => decisions[index] === 'visible');
    return page;
  }

  async rootCount(realm: string, rootTarget: string, principal?: VerifiedPrincipal, actor?: string) {
    const before = await realmReplyReadProof(this.access, this.env, realm, principal, actor);
    if (!before) throw new RealmReplyDenied('Realm is unavailable');
    const page = await readRootPlacementHeads(this.env, realm, rootTarget);
    let count = 0;
    const decisions = await discloseInventory(this.env, page.heads.map(placement => ({ owner: 'content' as const,
      resource: placement.reply, component: 'body' as const, revision: placement.revisionId,
      work: rootTarget, context: realm })), disclosureViewer(principal ?? null), 'count');
    for (const [index, placement] of page.heads.entries()) {
      if (decisions[index] !== 'visible') continue;
      if (await this.content.currentReview(realm, placement.reply, placement.revisionId,
        placement.reviewDecisionId, placement.preparationId)) count++;
    }
    if (await realmReplyReadProof(this.access, this.env, realm, principal, actor) !== before) throw new RealmReplyDenied('Realm is unavailable');
    return { realm, rootTarget, count, complete: page.complete };
  }
}
