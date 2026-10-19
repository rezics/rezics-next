import { readCurrentProfile } from '../realm-profile/commands.ts';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { ContentCore } from '../../../../content/src/core.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry, type RegisteredAdmission, type VerifiedPrincipal } from '../access/admission.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { RealmReplyDenied, RealmReplyInvalid, RealmReplyStale, RealmReplyUnavailable, type PlacementInput,
  type ReplyIdentityInput, type ReviewInput, type PlacementWithdrawalInput, type PlacementWithdrawalResult, RealmReplyContentStore } from './content-store.ts';
import { acknowledgeContentDecision, cancelPlacement, placeReply,
  readPlacementHead, readRootPlacementHeads, replySlotIri,
  readReplyGraphReceipt, assertPlacementWithdrawalOwner, withdrawReplyPlacement, type RealmReplyDispatchBasis, type ReplyGraphReceipt } from './graph.ts';
import { boundReplyRoot, readableReplyRoot } from './root.ts';
import { TargetUnavailable, targetRead } from '../target/resolve.ts';
import { WorkReadMissing, WorkReadUnavailable } from '../work/read-session.ts';
import { readRealmPolicy, reviewPolicy, type RealmPolicy } from '../space/policy.ts';
import type { RealmPermit } from '../access/realm-management-policy.ts';
import { discloseInventory } from '../disclosure/read.ts';
import { disclosureViewer } from '../disclosure/viewer.ts';
import { realmHistoryOriginCutFilter } from '../realm-admin/history.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import { RatingTargetNotAccepted } from '../rating/acceptance.ts';
import { RatingTargetGrainMismatch } from '../rating/release.ts';
import { fenceRealmThreadRemoval, finishRealmThreadRemoval, settleRealmThreadPlacement } from '../rankings/realm-threads.ts';
import { ControlUnavailable, controlTransaction } from '../access/topology-control.ts';
import { assertReplyBoardAuthority, readReplyBoards, replyBoards } from './boards.ts';

export type { RealmReplyDispatchBasis } from './graph.ts';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function realmReplyDigest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

/** A dependency that can recover is not an authority decision. Sealing it would
 * make the same key answer denied after the outage ends. These stay unsealed:
 * a work read that cannot finish, a target the write itself cannot reach, and
 * a busy graph or content owner (already `RealmReplyUnavailable`). Access
 * recovery is `AdmissionUnavailable`, a different class from a closed gate.
 * Expiry, revocation, deactivation, participation and an unverified account
 * are `AdmissionExpired` or `AdmissionDenied`; the caller seals those. */
const unavailableReply = (error: unknown): RealmReplyUnavailable | null => {
  if (error instanceof RealmReplyUnavailable) return error;
  if (error instanceof WorkReadUnavailable || error instanceof TargetUnavailable || error instanceof ControlUnavailable) {
    return new RealmReplyUnavailable(error.message);
  }
  return null;
};

const replyVisibilityMiss = (error: unknown): WorkReadMissing | null => {
  return error instanceof WorkReadMissing ? error : null;
};

function sealsReplyRefusal(error: unknown): boolean {
  if (unavailableReply(error) || error instanceof WorkReadMissing) return false;
  return error instanceof RealmReplyDenied || error instanceof RealmReplyInvalid || error instanceof RealmReplyStale
    || error instanceof RatingTargetNotAccepted || error instanceof RatingTargetGrainMismatch
    || error instanceof AdmissionDenied || error instanceof AdmissionExpired;
}

function expiredAdmission(error: unknown): RealmReplyStale | null {
  return error instanceof AdmissionExpired
    ? new RealmReplyStale('admission expired during claim verification') : null;
}

type RealmReadAuthority = Partial<Pick<AccessAdmissionRegistry, 'realmReadProof' | 'canReadWork'
  | 'canReadSemanticResource' | 'realmHistoryFloor'>>;

async function realmReplyReadState(access: RealmReadAuthority, env: WorkActivationEnvironment,
  realm: string, principal?: VerifiedPrincipal, actor?: string) {
  const policy = await readRealmPolicy(env, realm);
  if (!policy) return null;
  let decisions: Awaited<ReturnType<typeof discloseInventory>>;
  try {
    decisions = await discloseInventory(env, [{ owner: 'graph', resource: realm,
      component: 'record', revision: policy.realmRevision, context: realm }],
    disclosureViewer(principal ?? null), 'thread');
  } catch (error) {
    throw new RealmReplyUnavailable('Realm disclosure is unavailable', { cause: error });
  }
  if (decisions.length !== 1 || decisions.some(value => !['visible', 'hidden', 'tombstone'].includes(value))) {
    throw new RealmReplyUnavailable('Realm disclosure is incomplete');
  }
  if (decisions[0] !== 'visible') return null;
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
        | 'canReadWork' | 'canReadSemanticResource' | 'realmHistoryFloor' | 'withOwnerAuthority'>>,
    private readonly env: WorkActivationEnvironment,
    /** Read-only adapters omit this owner; commands require its exact index. */
    private readonly rankingAccess?: Pool) {}

  private async admission(principal: VerifiedPrincipal, actingSubject: string, action: string,
    scope: string, key: string, requestDigest: string, sourceRevision?: string): Promise<{
      registered: RegisteredAdmission; graph: ReplyGraphReceipt | null }> {
    await assertGraphAdmissionOpen(this.env.fuseki, this.env.lineage);
    const registered = await this.access.register({ principal, actingSubject, action, scope,
      idempotencyKey: key, requestDigest, baselineSourceRevision: sourceRevision });
    const contentAction = action === 'reply.place' ? 'publication.prepare' : action;
    const saved = await this.content.hasReceipt(registered.id, contentAction, requestDigest);
    if (registered.state === 'sealed') {
      const terminal = await readReplyGraphReceipt(this.env, registered);
      if (terminal?.outcome === 'cancelled') return { registered, graph: terminal };
      if (!saved) throw new RealmReplyUnavailable('sealed admission lost its Content receipt');
      return { registered, graph: terminal };
    }
    const prior = await readReplyGraphReceipt(this.env, registered);
    if (prior) return { registered, graph: prior };
    if (saved && registered.state === 'claimed') return { registered, graph: null };
    try {
      if (!registered.dispatchEligible) throw new AdmissionDenied('admission dispatch is fenced');
      return { registered: await this.access.claim(registered.id, requestDigest, principal), graph: null };
    }
    catch (error) {
      if (error instanceof AdmissionDenied || error instanceof AdmissionExpired) {
        // A concurrent winner can seal while claim waits. Recover its exact
        // receipt; a prepared-only placement still has no authority to publish.
        const raced = await readReplyGraphReceipt(this.env, registered);
        if (raced || action !== 'reply.place' && await this.content.hasReceipt(registered.id, contentAction, requestDigest)) {
          return { registered, graph: raced };
        }
        if (action === 'reply.place') {
          const terminal = await cancelPlacement(this.env, registered);
          if (terminal.outcome === 'succeeded') return { registered, graph: terminal };
          const prepared = await this.content.readPlacement(registered.id);
          if (prepared) await this.contentCore.settlePublication(`${registered.id}:settle`, registered.id, {
            outcome: 'rejected', revisionId: prepared.revisionId, receipt: terminal.receipt,
            dataEpoch: terminal.dataEpoch, sequence: terminal.sequence,
          });
          await this.access.recordGraphOutcome(registered.id, terminal);
        } else if (action === 'reply.create') {
          const refused = await this.refuseUncommittedCreate(registered, null);
          if (refused.terminal) await this.access.recordGraphOutcome(registered.id, refused.terminal);
          if (refused.replay) return { registered, graph: refused.terminal };
        }
        const expired = expiredAdmission(error);
        if (expired && (action === 'reply.place' || action === 'reply.create')) throw expired;
      }
      throw error;
    }
  }

  /** Reject under the Content operation lock, then cancel in the graph. The
   * graph step is idempotent: a lost result stays on this admission's rejected
   * receipt and a later attempt finishes it. Another reply is a different
   * admission and does not read that receipt. */
  private async refuseUncommittedCreate(admission: RegisteredAdmission, graph: ReplyGraphReceipt | null): Promise<{
    terminal: ReplyGraphReceipt | null; replay: boolean }> {
    const outcome = await this.content.createOutcome(admission);
    if (outcome === 'succeeded' || outcome === null && await this.content.rejectCreate(admission) === 'succeeded') {
      return { terminal: await acknowledgeContentDecision(this.env, admission, graph), replay: true };
    }
    return { terminal: await this.finishCreateCancellation(admission, graph), replay: false };
  }

  /** A rejected receipt names one admission. The graph cancel is the same
   * receipt written again until it exists; a lost result stays retryable and
   * is not a denial of any other admission. */
  private async finishCreateCancellation(admission: RegisteredAdmission, graph: ReplyGraphReceipt | null): Promise<ReplyGraphReceipt> {
    if (graph?.outcome === 'cancelled') return graph;
    return cancelPlacement(this.env, admission);
  }

  private async seal(admission: RegisteredAdmission, known?: ReplyGraphReceipt | null): Promise<void> {
    const terminal = known ?? await readReplyGraphReceipt(this.env, admission);
    if (!terminal) throw new RealmReplyUnavailable('terminal graph receipt is unavailable');
    await this.access.recordGraphOutcome(admission.id, terminal);
  }

  private async fence(admission: RegisteredAdmission, principal: VerifiedPrincipal, client?: PoolClient) {
    try {
      if (!client) return await this.access.claim(admission.id, admission.requestDigest, principal);
      if (!this.access.fenceClaim) throw new RealmReplyUnavailable('Realm dispatch authority is unavailable');
      return await this.access.fenceClaim(client, admission.id, admission.requestDigest, principal);
    } catch (error) {
      const expired = expiredAdmission(error);
      if (expired) throw expired;
      throw error;
    }
  }

  /** Unknown graph outcomes remain pending; only an exact terminal receipt may
   * be sealed, after the Realm callback has released its Access connection. */
  private async sealTerminal(admission: RegisteredAdmission, known?: ReplyGraphReceipt | null) {
    // Null means a command may have written a receipt this caller has not
    // reread. A receipt already in hand is not read again.
    const terminal = known ?? await readReplyGraphReceipt(this.env, admission);
    if (terminal) await this.access.recordGraphOutcome(admission.id, terminal);
  }

  async create(principal: VerifiedPrincipal, input: ReplyIdentityInput,
    key: string, digest: string) {
    const origin = await this.content.origin(input.reply);
    if (origin?.realm && !this.access.withRealmPolicy) throw new RealmReplyUnavailable('Realm policy owner is unavailable');
    // These transactions must commit before either native owner has an effect.
    const opened = await this.admission(principal, input.author, 'reply.create',
      `reply:create:${input.rootTarget}`, key, digest, input.rootRevision);
    const admission = opened.registered;
    let graph = opened.graph;
    let recordTerminal = true;
    try {
      const saved = await this.content.hasReceipt(admission.id, 'reply.create', digest);
      // The receipt is this admission's. A different idempotency key is a
      // different admission and must not inherit the denial.
      if (saved && await this.content.createOutcome(admission) === 'rejected') {
        graph = await this.finishCreateCancellation(admission, graph);
        throw new RealmReplyDenied('reply admission was cancelled');
      }
      if (graph?.outcome === 'cancelled' && !saved) {
        if (await this.content.rejectCreate(admission) === 'succeeded') {
          throw new RealmReplyUnavailable('reply identity is already admitted');
        }
        throw new RealmReplyDenied('reply admission was cancelled');
      }
      // The route already disclosed the root. A lost-response retry keeps its
      // identity after a target edit. A new opener binds the current root;
      // a child inherits its parent's retained root, whose exact coordinates
      // Content checks before creating the identity.
      const readable = await targetRead(this.env, { access: this.access, principal, actingSubject: input.author },
        session => boundReplyRoot(session, input.rootTarget, input.rootRevision, input.contextRevision,
          !saved && input.parentReply === null));
      if (!readable) throw new RealmReplyDenied('Reply root is unavailable');
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
      graph = await acknowledgeContentDecision(this.env, admission, graph);
      return result;
    }
    catch (error) {
      // A root lost after this write started is an unsealed 503. Recording a
      // terminal would deny the same key after the root can be read again.
      // The route already answered 404 when the caller could not see it.
      if (error instanceof TargetUnavailable) {
        recordTerminal = false;
        throw new RealmReplyUnavailable(error.message);
      }
      const unavailable = unavailableReply(error);
      if (unavailable) throw unavailable;
      // An expired admission is a refusal of a key that was admitted, not an outage.
      // A missing question or context after preflight refuses the admitted
      // reply about a visible root, so its denial is sealed below.
      const refusal = expiredAdmission(error)
        ?? (error instanceof WorkReadMissing ? new RealmReplyDenied(error.message) : error);
      if (refusal instanceof RealmReplyDenied || refusal instanceof RealmReplyInvalid || refusal instanceof RealmReplyStale
        || refusal instanceof RatingTargetNotAccepted || refusal instanceof RatingTargetGrainMismatch
        || refusal instanceof AdmissionDenied || refusal instanceof AdmissionExpired) {
        const refused = await this.refuseUncommittedCreate(admission, graph);
        graph = refused.terminal;
        if (refused.replay) return await this.content.createReply(admission, input);
      }
      throw refusal;
    } finally {
      if (recordTerminal) await this.sealTerminal(admission, graph);
    }
  }

  async review(principal: VerifiedPrincipal, actingSubject: string, input: ReviewInput,
    key: string, digest: string) {
    const opened = await this.admission(principal, actingSubject, 'review.decide',
      `review:decide:${input.realm}`, key, digest);
    if (!this.rankingAccess) throw new RealmReplyUnavailable('Realm ranking owner is unavailable');
    const removes = input.outcome !== 'approved' || input.supersedes !== null;
    try {
      if (removes) await fenceRealmThreadRemoval(this.rankingAccess, this.env.lineage.dataEpoch,
        input.realm, input.reply, opened.registered.id);
      const result = await this.content.decideReview(opened.registered, input);
      if (removes) await finishRealmThreadRemoval(this.rankingAccess, this.env.lineage.dataEpoch,
        input.realm, input.reply, opened.registered.id);
      const terminal = await acknowledgeContentDecision(this.env, opened.registered, opened.graph);
      await this.seal(opened.registered, terminal);
      return result;
    } catch (error) {
      if (removes && (error instanceof RealmReplyStale || error instanceof RealmReplyDenied || error instanceof RealmReplyInvalid))
        await controlTransaction(this.rankingAccess, client => client.query(`DELETE FROM access.realm_thread_dirty
          WHERE data_epoch=$1 AND kind='placement' AND resource=$2 AND after_key=$3`,
        [this.env.lineage.dataEpoch, `${input.realm}|${input.reply}|${opened.registered.id}`, `pending:${opened.registered.id}`]));
      throw unavailableReply(error) ?? error;
    }
  }

  async withdraw(principal: VerifiedPrincipal, actingSubject: string, input: PlacementWithdrawalInput,
    key: string, digest: string): Promise<PlacementWithdrawalResult> {
    await assertGraphAdmissionOpen(this.env.fuseki, this.env.lineage);
    const registered = await this.access.register({ principal, actingSubject, action: 'reply.place',
      scope: `reply:place:${input.realm}`, idempotencyKey: key, requestDigest: digest });
    if (!this.access.withOwnerAuthority) throw new RealmReplyUnavailable('live author authority is unavailable');
    const result = await this.access.withOwnerAuthority({ principal, actingSubject,
      action: 'agent.control', scope: `agent:control:${actingSubject}` }, async () => {
      await assertPlacementWithdrawalOwner(this.env, actingSubject, input);
      const prior = await readReplyGraphReceipt(this.env, registered);
      if (prior) return prior;
      const admission = await this.fence(registered, principal);
      if (!this.rankingAccess) throw new RealmReplyUnavailable('Realm ranking owner is unavailable');
      await fenceRealmThreadRemoval(this.rankingAccess, this.env.lineage.dataEpoch,
        input.realm, input.reply, admission.id);
      return withdrawReplyPlacement(this.env, admission, input);
    });
    await this.seal(registered, result);
    if (result.outcome === 'cancelled') {
      if (this.rankingAccess) await finishRealmThreadRemoval(this.rankingAccess, this.env.lineage.dataEpoch,
        input.realm, input.reply, registered.id);
      throw new RealmReplyStale('Realm reply placement head or exact revision moved');
    }
    if (!result.placement || result.realm !== input.realm || result.reply !== input.reply
      || result.revisionId !== input.expectedRevisionId || result.predecessor !== input.expectedHead) {
      throw new RealmReplyUnavailable('withdrawal receipt differs from exact intent');
    }
    if (this.rankingAccess) await finishRealmThreadRemoval(this.rankingAccess, this.env.lineage.dataEpoch,
      input.realm, input.reply, registered.id);
    return { profile: 'realm-reply-placement-withdrawal-v1', realm: input.realm, reply: input.reply,
      revisionId: input.expectedRevisionId, withdrawnPlacement: input.expectedHead,
      withdrawal: result.placement, replayed: registered.replayed };
  }

  /** Exact history uses retained Content authorship, live Agent control and the
   * same current placement/Realm visibility owner as ordinary reply reads. */
  async hasRevision(reply: string, revisionId: string): Promise<boolean> {
    return await this.content.revisionAuthor(reply, revisionId) !== null;
  }

  async canReadRevision(reply: string, revisionId: string, principal?: VerifiedPrincipal, actor?: string): Promise<boolean> {
    const retained = await this.content.revisionAuthor(reply, revisionId);
    if (!retained) return false;
    if (principal && actor === retained.author && this.access.withOwnerAuthority) {
      try {
        return await this.access.withOwnerAuthority({ principal, actingSubject: actor,
          action: 'agent.control', scope: `agent:control:${actor}` }, () => Promise.resolve(true));
      } catch (error) { if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error; }
    }
    if ((await this.readPublic(reply, principal, actor))?.revisionId === revisionId) return true;
    if (!await readableReplyRoot(this.env, retained.rootTarget, retained.rootRevision,
      this.access, principal ?? null, actor)) return false;
    const rows = (await this.env.fuseki.query(`PREFIX rv: <${RV}> SELECT DISTINCT ?realm WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?slot rv:reply ${iri(reply)} ; rv:realm ?realm ; rv:replyPlacementHead ?head . }
      GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:RealmReplyPlacement ; rv:placementOutcome rv:Accepted ;
        rv:reply ${iri(reply)} ; rv:contentRevision ${iri(`urn:rezics:content:revision:${revisionId}`)} . }
    } LIMIT 65`)).results?.bindings ?? [];
    if (rows.length > 64) throw new RealmReplyUnavailable('exact reply placement inventory exceeds its bound');
    for (const row of rows) {
      if (!row.realm) throw new RealmReplyUnavailable('exact reply Realm is unavailable');
      const visible = await this.visible(row.realm.value, reply, principal, actor);
      if (visible?.revisionId === revisionId) return true;
    }
    return false;
  }

  async place(principal: VerifiedPrincipal, actingSubject: string, input: PlacementInput,
    key: string, digest: string, basis?: RealmReplyDispatchBasis) {
    replyBoards(input);
    const opened = await this.admission(principal, actingSubject, 'reply.place',
      `reply:place:${input.realm}`, key, digest);
    const admission = opened.registered;
    let graph = opened.graph;
    // This flag describes the immutable admission proof, not current authority;
    // fenceClaim rechecks its membership generation inside the Realm callback.
    const memberAdmission = input.reviewDecisionId === null
      && await this.access.hasRealmMemberAdmission?.(admission.id) === true;
    try {
      const placed = graph || !this.access.withRealmPolicy
        ? await this.placeAdmitted(principal, input, admission, memberAdmission, graph, undefined, undefined, basis)
        : await this.access.withRealmPolicy(principal, actingSubject, input.realm, 'reply',
          (permit, client) => this.placeAdmitted(principal, input, admission, memberAdmission, graph, permit, client, basis));
      graph = placed.terminal;
      return placed.body;
    } catch (error) {
      const refusal = expiredAdmission(error) ?? error;
      const unavailable = unavailableReply(refusal);
      if (unavailable) throw unavailable;
      const missed = replyVisibilityMiss(refusal);
      if (missed) throw missed;
      if (sealsReplyRefusal(refusal)) {
        // The native receipt lock chooses cancellation or the concurrent
        // winner. Transport failures do not imply either terminal outcome.
        const terminal = await cancelPlacement(this.env, admission);
        graph = terminal;
        if (terminal.outcome === 'succeeded') {
          const placed = await this.placeAdmitted(principal, input, admission, memberAdmission, terminal, undefined, undefined, basis);
          graph = placed.terminal;
          return placed.body;
        }
        const prepared = await this.content.readPlacement(admission.id);
        if (prepared) await this.contentCore.settlePublication(`${admission.id}:settle`, admission.id, {
          outcome: 'rejected', revisionId: input.revisionId, receipt: terminal.receipt,
          dataEpoch: terminal.dataEpoch, sequence: terminal.sequence,
        });
      }
      throw refusal;
    } finally {
      await this.sealTerminal(admission, graph);
    }
  }

  private async placeAdmitted(principal: VerifiedPrincipal, input: PlacementInput,
    admission: RegisteredAdmission, memberAdmission: boolean, observed: ReplyGraphReceipt | null,
    permit?: RealmPermit, client?: PoolClient, basis?: RealmReplyDispatchBasis) {
    if (!this.rankingAccess) throw new RealmReplyUnavailable('Realm ranking owner is unavailable');
    const unified = await readRealmPolicy(this.env, input.realm);
    if (permit && (!unified || unified.visibility !== 'public' && !permit.member)) {
      throw new RealmReplyDenied('Realm membership is required');
    }
    const existing = observed;
    const boards = replyBoards(input);
    let prepared = await this.content.readPlacement(admission.id);
    if (existing?.outcome === 'cancelled' && !prepared) throw new RealmReplyStale('Realm reply placement was cancelled');
    let publicationInput = input;
    if (boards && !existing) {
      if (!client || !permit) throw new RealmReplyUnavailable('Board authority owner is unavailable');
      const current = await readPlacementHead(this.env, input.realm, input.reply);
      if ((current?.placement ?? null) !== input.expectedHead || current && current.revisionId !== input.revisionId) {
        throw new RealmReplyStale('Board edit requires the current placed reply revision');
      }
      const content = current ? null : await this.content.readCurrent(input.reply);
      if (!current && (!content || content.revisionId !== input.revisionId))
        throw new RealmReplyStale('Board placement requires the current reply revision');
      const previous = current ? await readReplyBoards(this.env, current.placement)
        : { concepts: [], primaryConcept: null };
      await assertReplyBoardAuthority(client, principal, input.realm, admission.actingSubject,
        current?.author ?? content!.author, permit.member || unified?.reviewMode === 'open', previous, boards);
      // Classification never manufactures approval or changes the accepted bytes.
      if (current && input.reviewDecisionId !== null && input.reviewDecisionId !== current.reviewDecisionId)
        throw new RealmReplyInvalid('Board edit must retain the placement review');
      if (current) publicationInput = { ...input, reviewDecisionId: current.reviewDecisionId };
    }
    if (!prepared && !existing) {
      await this.fence(admission, principal, client);
      let directPolicyRevision: string | undefined;
      let directPolicy: string | undefined;
      if (publicationInput.reviewDecisionId === null) {
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
      prepared = await this.content.preparePlacement(admission, publicationInput, directPolicyRevision, directPolicy);
    }
    if (!prepared) throw new RealmReplyUnavailable('Realm placement lost its Content preparation');
    let terminal = existing;
    if (!terminal) {
      await this.fence(admission, principal, client);
      // A previous attempt can leave the pin while its graph result is unknown.
      // The immutable receipt resolves that ambiguity before another dispatch.
      // The caller already observed that this receipt was absent.
      terminal = await placeReply(this.env, admission, prepared, input.expectedHead, null, basis, boards);
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
    // Replay returns the immutable receipt, but must not re-index a superseded placement.
    const live = existing ? await readPlacementHead(this.env, input.realm, input.reply) : null;
    if (!existing || live?.placement === terminal.placement) await settleRealmThreadPlacement(this.rankingAccess, terminal.dataEpoch, prepared, terminal.placement, client, {
      concepts: boards?.concepts ?? (input.expectedHead ? (await readReplyBoards(this.env, terminal.placement)).concepts : []),
      newEpoch: 0, newSequence: terminal.sequence,
    });
    return { terminal, body: { placement: terminal.placement, reply: input.reply, realm: input.realm,
      ...(boards ?? {}),
      revisionId: input.revisionId, reviewDecisionId: prepared.reviewDecisionId, reviewGeneration: prepared.reviewGeneration,
      replayed: admission.replayed || prepared.replayed } };
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
    let result = await this.content.readCurrent(reply);
    if (!result || !await readableReplyRoot(this.env, result.rootTarget, result.rootRevision,
      this.access, principal ?? null, actor)) return null;
    if (result.originRealm) {
      const visible = await this.visible(result.originRealm, reply, principal, actor);
      if (!visible) return null;
      if (visible.revisionId !== result.revisionId) result = await this.content.readCurrent(reply, visible.revisionId);
      if (!result || (await this.visible(result.originRealm!, reply, principal, actor))?.revisionId !== result.revisionId) return null;
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
   * At most 32 children and 32 immediate parent body reads, with two Realm
   * policy fences per page. Parent reads retain their own placement/review fences. */
  async listPublic(rootTarget: string, rootRevision: string, after?: string, realm?: string,
    principal?: VerifiedPrincipal, actor?: string) {
    await assertGraphAdmissionOpen(this.env.fuseki, this.env.lineage);
    if (!await readableReplyRoot(this.env, rootTarget, rootRevision, this.access, principal ?? null, actor)) return null;
    const before = realm ? await realmReplyReadProof(this.access, this.env, realm, principal, actor) : 'public';
    if (!before) return null;
    const page = await this.content.listCurrent(rootTarget, rootRevision, after, realm ?? null);
    if (realm) {
      const selected = await Promise.all(page.items.map(async item => {
        const visible = await this.visible(realm, item.reply as string, principal, actor);
        if (!visible) return null;
        if (visible.revisionId === item.revisionId) return item;
        const exact = await this.content.readCurrent(item.reply as string, visible.revisionId);
        if (!exact || (await this.visible(realm, item.reply as string, principal, actor))?.revisionId !== exact.revisionId) return null;
        return { ...item, ...exact };
      }));
      page.items = selected.filter(item => item !== null);
    }
    if (!await readableReplyRoot(this.env, rootTarget, rootRevision, this.access, principal ?? null, actor)) return null;
    const decisions = await discloseInventory(this.env, page.items.map(item => ({ owner: 'content' as const,
      resource: item.reply, component: 'body' as const, revision: item.revisionId,
      work: rootTarget, context: realm })), disclosureViewer(principal ?? null), 'thread');
    page.items = page.items.filter((_item, index) => decisions[index] === 'visible');
    if (page.items.length > 32) throw new RealmReplyUnavailable('Reply page exceeds its owner bound');
    const parents = [...new Set(page.items.flatMap(item => item.parentReply ? [item.parentReply as string] : []))];
    // Parent coordinates disclose another contribution. Its existing body owner
    // must authorize that exact revision for this same reader; do not walk ancestry.
    const parentBodies = parents.length ? await this.readPublicBatch(parents, principal, actor) : [];
    const revisions = new Map(parents.map((parent, index) => [parent, parentBodies[index]?.revisionId]));
    page.items = page.items.map(item => item.parentReply && item.parentRevision
      && revisions.get(item.parentReply as string) === item.parentRevision
      ? item : { ...item, parentReply: null, parentRevision: null });
    // The closing Realm fence includes the parent owner reads as well as the children.
    if (realm && await realmReplyReadProof(this.access, this.env, realm, principal, actor) !== before) return null;
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
