import { readCurrentProfile } from '../realm-profile/commands.ts';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ContentCore } from '../../../../content/src/core.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry, type RegisteredAdmission, type VerifiedPrincipal } from '../access/admission.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { RealmReplyDenied, RealmReplyInvalid, RealmReplyStale, RealmReplyUnavailable, type PlacementInput,
  type ReplyIdentityInput, type ReviewInput, RealmReplyContentStore } from './content-store.ts';
import { acknowledgeContentDecision, cancelPlacement, placeReply,
  readPlacementHead, readRootPlacementHeads, replySlotIri,
  readReplyGraphReceipt } from './graph.ts';
import { readableReplyRoot, replyRoot } from './root.ts';
import { targetRead } from '../target/resolve.ts';
import { WorkReadMissing } from '../work/read-session.ts';
import { readRealmPolicy, reviewPolicy, type RealmPolicy } from '../space/policy.ts';
import type { RealmPermit } from '../access/realm-management-policy.ts';
import { discloseInventory } from '../disclosure/read.ts';
import { disclosureViewer } from '../disclosure/viewer.ts';
import { realmHistoryOriginCutFilter } from '../realm-admin/history.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import { RatingTargetNotAccepted } from '../rating/acceptance.ts';
import { RatingTargetGrainMismatch } from '../rating/release.ts';

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
  | 'canReadSemanticResource' | 'realmHistoryFloor'>>;

async function realmReplyReadState(access: RealmReadAuthority, env: WorkActivationEnvironment,
  realm: string, principal?: VerifiedPrincipal, actor?: string) {
  const policy = await readRealmPolicy(env, realm);
  if (!policy) return null;
  const member = policy.visibility === 'private'
    ? principal && actor ? await access.realmReadProof?.(principal, actor, realm) : null : 'public';
  return member ? { policy, proof: JSON.stringify([policy, member]) } : null;
}

async function realmReplyReadProof(access: RealmReadAuthority, env: WorkActivationEnvironment,
  realm: string, principal?: VerifiedPrincipal, actor?: string): Promise<string | null> {
  return (await realmReplyReadState(access, env, realm, principal, actor))?.proof ?? null;
}

/** The caller fences the shared Realm policy around these exact owner reads. */
async function readVisiblePlacement(content: Pick<RealmReplyContentStore, 'currentReview'>,
  access: RealmReadAuthority, env: WorkActivationEnvironment, realm: string, reply: string,
  policy: RealmPolicy, principal?: VerifiedPrincipal, actor?: string) {
  const placement = await readPlacementHead(env, realm, reply);
  if (!placement) return null;
  if (policy.visibility === 'private' && policy.history === 'from-admission') {
    if (!principal || !actor || !access.realmHistoryFloor) throw new RealmReplyUnavailable('Realm history admission is unavailable');
    const floor = await access.realmHistoryFloor(principal, actor, realm);
    if (floor) {
      const filter = await realmHistoryOriginCutFilter(env, floor, realm, 'placement', iri(replySlotIri(realm,reply)));
      const allowed = await env.fuseki.query(`PREFIX rv: <${RV}> ASK { ${filter} }`, 1024);
      if (allowed.boolean !== true) return null;
    }
  }
  if (!await content.currentReview(realm, reply, placement.revisionId,
    placement.reviewDecisionId, placement.preparationId)) return null;
  return placement;
}

/** The same exact placement, Content review and two-sided Realm fence serve direct reads and notifications. */
export async function visibleRealmReply(content: Pick<RealmReplyContentStore, 'currentReview'>,
  access: RealmReadAuthority, env: WorkActivationEnvironment, realm: string, reply: string,
  principal?: VerifiedPrincipal, actor?: string) {
  const before = await realmReplyReadState(access, env, realm, principal, actor);
  if (!before) return null;
  const placement = await readVisiblePlacement(content, access, env, realm, reply, before.policy, principal, actor);
  if (!placement) return null;
  return await realmReplyReadProof(access, env, realm, principal, actor) === before.proof ? placement : null;
}

/** Content owns identities and exact review; Jena owns Realm-local placement. */
export class RealmReplyStore {
  constructor(private readonly content: RealmReplyContentStore,
    private readonly contentCore: Pick<ContentCore, 'settlePublication'>,
    private readonly access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>
      & Partial<Pick<AccessAdmissionRegistry, 'fenceClaim' | 'hasRealmMemberAdmission' | 'withRealmPolicy' | 'realmReadProof'
        | 'canReadWork' | 'canReadSemanticResource' | 'realmHistoryFloor'>>,
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
    try {
      if (!registered.dispatchEligible) throw new AdmissionDenied('admission dispatch is fenced');
      return await this.access.claim(registered.id, requestDigest, principal);
    }
    catch (error) {
      if (error instanceof AdmissionDenied || error instanceof AdmissionExpired) {
        // A concurrent winner can seal while claim waits. Recover its exact
        // receipt; a prepared-only placement still has no authority to publish.
        if (await readReplyGraphReceipt(this.env, registered)
          || action !== 'reply.place' && await this.content.hasReceipt(registered.id, contentAction, requestDigest)) return registered;
        if (action === 'reply.place') {
          const terminal = await cancelPlacement(this.env, registered);
          if (terminal.outcome === 'succeeded') return registered;
          const prepared = await this.content.readPlacement(registered.id);
          if (prepared) await this.contentCore.settlePublication(`${registered.id}:settle`, registered.id, {
            outcome: 'rejected', revisionId: prepared.revisionId, receipt: terminal.receipt,
            dataEpoch: terminal.dataEpoch, sequence: terminal.sequence,
          });
          await this.access.recordGraphOutcome(registered.id, terminal);
        } else if (action === 'reply.create') {
          const succeeded = await this.content.cancelCreate(registered);
          const terminal = succeeded ? await acknowledgeContentDecision(this.env, registered)
            : await cancelPlacement(this.env, registered);
          await this.access.recordGraphOutcome(registered.id, terminal);
          if (succeeded) return registered;
        }
        if (error instanceof AdmissionExpired && (action === 'reply.place' || action === 'reply.create'))
          throw new RealmReplyStale('admission expired during claim verification');
      }
      throw error;
    }
  }

  private async seal(admission: RegisteredAdmission): Promise<void> {
    const terminal = await readReplyGraphReceipt(this.env, admission);
    if (!terminal) throw new RealmReplyUnavailable('terminal graph receipt is unavailable');
    await this.access.recordGraphOutcome(admission.id, terminal);
  }

  private async fence(admission: RegisteredAdmission, principal: VerifiedPrincipal, client?: PoolClient) {
    try {
      if (!client) return await this.access.claim(admission.id, admission.requestDigest, principal);
      if (!this.access.fenceClaim) throw new RealmReplyUnavailable('Realm dispatch authority is unavailable');
      return await this.access.fenceClaim(client, admission.id, admission.requestDigest, principal);
    } catch (error) {
      if (error instanceof AdmissionExpired) throw new RealmReplyStale('admission expired during claim verification');
      throw error;
    }
  }

  /** Unknown graph outcomes remain pending; only an exact terminal receipt may
   * be sealed, after the Realm callback has released its Access connection. */
  private async sealTerminal(admission: RegisteredAdmission) {
    const terminal = await readReplyGraphReceipt(this.env, admission);
    if (terminal) await this.access.recordGraphOutcome(admission.id, terminal);
  }

  async create(principal: VerifiedPrincipal, input: ReplyIdentityInput,
    key: string, digest: string) {
    const origin = await this.content.origin(input.reply);
    if (origin?.realm && !this.access.withRealmPolicy) throw new RealmReplyUnavailable('Realm policy owner is unavailable');
    // These transactions must commit before either native owner has an effect.
    const admission = await this.admission(principal, input.author, 'reply.create',
      `reply:create:${input.rootTarget}`, key, digest, input.rootRevision);
    try {
      const saved = await this.content.hasReceipt(admission.id, 'reply.create', digest);
      // A lost-response retry retains its successful identity after a target edit.
      // Only a new Content identity must bind to the target's current root.
      if (!saved) {
        const currentRoot = await targetRead(this.env, { access: this.access, principal, actingSubject: input.author },
          session => replyRoot(session, input.rootTarget, input.rootRevision, input.contextRevision));
        if (!currentRoot) throw new RealmReplyDenied('Reply root is unavailable');
      }
      const create = async (client?: PoolClient) => {
        if (!saved) await this.fence(admission, principal, client);
        return this.content.createReply(admission, input);
      };
      const result = origin?.realm && !saved
        ? await this.access.withRealmPolicy!(principal, input.author, origin.realm, 'reply', async (permit, client) => {
          const policy = await readRealmPolicy(this.env, origin.realm!);
          if (!policy || policy.visibility !== 'public' && !permit.member) throw new RealmReplyDenied('Realm membership is required');
          return create(client);
        }) : await create();
      await acknowledgeContentDecision(this.env, admission);
      return result;
    }
    catch (error) {
      if (error instanceof WorkReadMissing) error = new RealmReplyDenied('Reply root is unavailable');
      if (error instanceof RealmReplyDenied || error instanceof RealmReplyInvalid || error instanceof RealmReplyStale
        || error instanceof RatingTargetNotAccepted || error instanceof RatingTargetGrainMismatch
        || error instanceof AdmissionDenied || error instanceof AdmissionExpired) {
        const succeeded = await this.content.cancelCreate(admission);
        if (succeeded) await acknowledgeContentDecision(this.env, admission);
        else await cancelPlacement(this.env, admission);
        if (succeeded)
          return await this.content.createReply(admission, input);
      }
      throw error;
    } finally {
      await this.sealTerminal(admission);
    }
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
    const terminal = await readReplyGraphReceipt(this.env, admission);
    // This flag describes the immutable admission proof, not current authority;
    // fenceClaim rechecks its membership generation inside the Realm callback.
    const memberAdmission = input.reviewDecisionId === null
      && await this.access.hasRealmMemberAdmission?.(admission.id) === true;
    try {
      if (terminal || !this.access.withRealmPolicy)
        return await this.placeAdmitted(principal, input, admission, memberAdmission);
      return await this.access.withRealmPolicy(principal, actingSubject, input.realm, 'reply',
        (permit, client) => this.placeAdmitted(principal, input, admission, memberAdmission, permit, client));
    } catch (error) {
      if (error instanceof AdmissionDenied || error instanceof AdmissionExpired
        || error instanceof RealmReplyDenied || error instanceof RealmReplyInvalid || error instanceof RealmReplyStale) {
        // The native receipt lock chooses cancellation or the concurrent
        // winner. Transport failures do not imply either terminal outcome.
        const terminal = await cancelPlacement(this.env, admission);
        if (terminal.outcome === 'succeeded')
          return await this.placeAdmitted(principal, input, admission, memberAdmission);
        const prepared = await this.content.readPlacement(admission.id);
        if (prepared) await this.contentCore.settlePublication(`${admission.id}:settle`, admission.id, {
          outcome: 'rejected', revisionId: input.revisionId, receipt: terminal.receipt,
          dataEpoch: terminal.dataEpoch, sequence: terminal.sequence,
        });
      }
      throw error;
    } finally {
      await this.sealTerminal(admission);
    }
  }

  private async placeAdmitted(principal: VerifiedPrincipal, input: PlacementInput,
    admission: RegisteredAdmission, memberAdmission: boolean, permit?: RealmPermit, client?: PoolClient) {
    const unified = await readRealmPolicy(this.env, input.realm);
    if (permit && (!unified || unified.visibility !== 'public' && !permit.member)) {
      throw new RealmReplyDenied('Realm membership is required');
    }
    const existing = await readReplyGraphReceipt(this.env, admission);
    let prepared = await this.content.readPlacement(admission.id);
    if (existing?.outcome === 'cancelled' && !prepared) throw new RealmReplyStale('Realm reply placement was cancelled');
    if (!prepared && !existing) {
      await this.fence(admission, principal, client);
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
            || !memberAdmission) {
            throw new RealmReplyDenied('Realm policy requires moderator approval');
          }
          directPolicyRevision = policy.revision;
        }
      }
      prepared = await this.content.preparePlacement(admission, input, directPolicyRevision, directPolicy);
    }
    if (!prepared) throw new RealmReplyUnavailable('Realm placement lost its Content preparation');
    let terminal = await readReplyGraphReceipt(this.env, admission);
    if (!terminal) {
      await this.fence(admission, principal, client);
      // A previous attempt can leave the pin while its graph result is unknown.
      // The immutable receipt resolves that ambiguity before another dispatch.
      terminal = await placeReply(this.env, admission, prepared, input.expectedHead);
    }
    if (terminal.outcome === 'cancelled') {
      await this.contentCore.settlePublication(`${admission.id}:settle`, admission.id, {
        outcome: 'rejected', revisionId: input.revisionId, receipt: terminal.receipt,
        dataEpoch: terminal.dataEpoch, sequence: terminal.sequence,
      });
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
    return { placement: terminal.placement, reply: input.reply, realm: input.realm,
      revisionId: input.revisionId, reviewDecisionId: prepared.reviewDecisionId, reviewGeneration: prepared.reviewGeneration,
      replayed: admission.replayed || prepared.replayed };
  }

  async visible(realm: string, reply: string, principal?: VerifiedPrincipal, actor?: string) {
    return visibleRealmReply(this.content, this.access, this.env, realm, reply, principal, actor);
  }

  /** Public Feed references only. Public Realm/placement facts share one graph
   * cut; Content approvals share one indexed statement. The feed envelope
   * fences the graph and this exact approval set again before delivery. */
  async visiblePublicBatch(requested: readonly { realm: string; reply: string }[]) {
    if (requested.length > 8 || requested.some(row => !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(row.realm)
      || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(row.reply))) throw new RealmReplyInvalid('invalid feed placement batch');
    if (!requested.length) return [];
    const rows = (await this.env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?realm ?reply ?placement ?revision ?review ?root ?rootRevision ?author ?preparation WHERE {
      VALUES (?realm ?reply) { ${requested.map(row => `(${iri(row.realm)} ${iri(row.reply)})`).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} { ?slot a rv:RealmReplySlot ; rv:realm ?realm ; rv:reply ?reply ; rv:replyPlacementHead ?placement .
        ?realm a rv:Realm ; rv:realmState rv:Active ; rv:space ?space .
        ?space a rv:Space ; rv:realmCapability ?realm ; rv:disclosure rv:Public .
        FILTER NOT EXISTS { ?space rv:disclosure rv:Private }
        FILTER NOT EXISTS { ?realm rv:protectionHead ?protection }
        OPTIONAL { ?realm rv:visibility ?visibility }
        FILTER(!BOUND(?visibility) || ?visibility IN ("public","restricted")) }
      GRAPH ${iri(GRAPHS.revisions)} { ?placement a rv:RealmReplyPlacement ; rv:realm ?realm ; rv:reply ?reply ; rv:placementOutcome rv:Accepted ;
        rv:contentRevision ?revision ; rv:reviewDecision ?review ; rv:rootTarget ?root ; rv:rootRevision ?rootRevision ; rv:author ?author ; rv:contentPreparation ?preparation . }
    } LIMIT ${requested.length + 1}`)).results?.bindings ?? [];
    if (rows.length > requested.length) throw new RealmReplyUnavailable('Feed placement is ambiguous');
    const heads = rows.map(row => ({ realm: row.realm!.value, reply: row.reply!.value,
      revisionId: row.revision!.value.replace('urn:rezics:content:revision:', ''),
      reviewDecisionId: row.review!.value.replace('urn:rezics:realm-review:', ''), preparationId: row.preparation!.value,
      placement: row.placement!.value, rootTarget: row.root!.value, rootRevision: row.rootRevision!.value, author: row.author!.value }));
    const approved = await this.content.currentReviews(heads);
    return heads.filter((_,index) => approved.has(index));
  }

  currentFeedApprovals(heads: Parameters<RealmReplyContentStore['currentReviews']>[0]) {
    return this.content.currentReviews(heads);
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
    const before = await realmReplyReadState(this.access, this.env, realm, principal, actor);
    if (!before) throw new RealmReplyDenied('Realm is unavailable');
    const page = await readRootPlacementHeads(this.env, realm, rootTarget);
    let count = 0;
    const decisions = await discloseInventory(this.env, page.heads.map(placement => ({ owner: 'content' as const,
      resource: placement.reply, component: 'body' as const, revision: placement.revisionId,
      work: rootTarget, context: realm })), disclosureViewer(principal ?? null), 'count');
    for (const [index, placement] of page.heads.entries()) {
      if (decisions[index] !== 'visible') continue;
      // One two-sided Realm fence covers this count's bounded inventory; each
      // placement and exact Content review still gets its own live check.
      if (await readVisiblePlacement(this.content, this.access, this.env, realm, placement.reply,
        before.policy, principal, actor)) count++;
    }
    if (await realmReplyReadProof(this.access, this.env, realm, principal, actor) !== before.proof) throw new RealmReplyDenied('Realm is unavailable');
    return { realm, rootTarget, count, complete: page.complete };
  }
}
