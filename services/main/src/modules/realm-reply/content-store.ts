import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { RegisteredAdmission } from '../access/admission.ts';

export class RealmReplyInvalid extends Error {}
export class RealmReplyDenied extends Error {}
export class RealmReplyStale extends Error {}
export class RealmReplyConflict extends Error {}
export class RealmReplyUnavailable extends Error {}

const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const REVIEW_POLICY = 'https://rezics.com/definition/realm-manager-reviewed-v1';

export interface ReplyIdentityInput {
  originRealm?: string | null;
  reply: string; variantId: string; revisionId: string; author: string;
  rootTarget: string; rootRevision: string; parentReply: string | null;
  parentRevision: string | null; contextRevision: string | null;
}
export interface ReviewInput {
  realm: string; reply: string; revisionId: string; revisionDigest: string;
  expectedGeneration: string; supersedes: string | null;
  outcome: 'approved' | 'rejected' | 'unavailable' | 'revoked';
  method: 'human' | 'ai'; methodRevision: string; dependencyDigest: string;
  reasonReference: string | null;
}
export interface PlacementInput {
  realm: string; reply: string; revisionId: string; revisionDigest: string;
  reviewDecisionId: string | null; expectedHead: string | null;
}
export interface ReplyIdentity extends ReplyIdentityInput { replayed: boolean }
export interface ReviewDecision {
  decisionId: string; realm: string; reply: string; revisionId: string;
  generation: string; outcome: ReviewInput['outcome']; revisionDigest: string;
  replayed: boolean;
}
export interface PlacementPreparation {
  directPolicyRevision?: string;
  operationId: string; realm: string; reply: string; revisionId: string;
  revisionDigest: string; reviewDecisionId: string; reviewDigest: string; author: string;
  ownerDataEpoch: string; ownerSequence: string;
  rootTarget: string; rootRevision: string; parentReply: string | null;
  parentRevision: string | null; contextRevision: string | null;
  replayed: boolean;
}

interface Receipt { action: string; request_digest: string; outcome: string }

function assertText(value: string | null, max = 300): void {
  if (value !== null && (!value || value.length > max || value.includes('\0'))) {
    throw new RealmReplyInvalid('invalid bounded reference');
  }
}
function assertIdentity(input: ReplyIdentityInput): void {
  if (![input.reply, input.author, input.rootTarget].every(value => native.test(value))
    || !uuid.test(input.revisionId) || !input.variantId || input.variantId.length > 300
    || (input.parentReply !== null && !native.test(input.parentReply))
    || (input.parentRevision !== null && !uuid.test(input.parentRevision))
    || (input.parentReply === null) !== (input.parentRevision === null)
    || (input.contextRevision !== null && !native.test(input.contextRevision))) {
    throw new RealmReplyInvalid('invalid reply identity');
  }
  assertText(input.variantId);
  assertText(input.rootRevision);
}

/** Content owner writes use the same owner-control sequence and receipt/outbox
 * tables as ContentCore. Access admission IDs are the owner operation IDs. */
export class RealmReplyContentStore {
  constructor(private readonly pool: Pool) {}

  async origin(reply: string): Promise<{ realm: string | null } | null> {
    const row = (await this.pool.query<{ origin_realm: string | null }>(
      'SELECT origin_realm FROM content.reply_author WHERE reply = $1', [reply])).rows[0];
    return row ? { realm: row.origin_realm } : null;
  }

  async hasReceipt(operationId: string, action: string, requestDigest: string): Promise<boolean> {
    const result = await this.pool.query<Receipt>(`SELECT action, request_digest FROM content.receipt
      WHERE operation_id = $1`, [operationId]);
    const row = result.rows[0];
    if (!row) return false;
    if (row.action !== action || row.request_digest !== requestDigest) {
      throw new RealmReplyConflict('operation ID binds another Content intent');
    }
    return true;
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      if (error && typeof error === 'object' && 'code' in error) {
        const code = String(error.code);
        if (['40001', '40P01', '55P03', '57014'].includes(code)) {
          throw new RealmReplyUnavailable('Content owner lock budget exhausted');
        }
      }
      throw error;
    } finally { client.release(); }
  }

  private async prior(client: PoolClient, admission: RegisteredAdmission, action: string): Promise<boolean> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`realm-reply:${admission.id}`]);
    const receipt = await client.query<Receipt>(`SELECT action, request_digest, outcome FROM content.receipt
      WHERE operation_id = $1`, [admission.id]);
    if (!receipt.rows[0]) return false;
    if (receipt.rows[0].action !== action || receipt.rows[0].request_digest !== admission.requestDigest) {
      throw new RealmReplyConflict('operation ID binds another intent');
    }
    if (receipt.rows[0].outcome === 'rejected') throw new RealmReplyDenied('reply admission was cancelled');
    return true;
  }

  private async receipt(client: PoolClient, admission: RegisteredAdmission, action: string,
    variantId: string, revisionId: string, eventType: string, payload: Record<string, unknown>): Promise<void> {
    const position = await client.query<{ data_epoch: string; sequence: string }>(`
      UPDATE content.owner_control SET sequence = sequence + 1 WHERE singleton
      RETURNING data_epoch, sequence::text AS sequence`);
    if (!position.rows[0]) throw new RealmReplyUnavailable('Content owner position is absent');
    const { data_epoch, sequence } = position.rows[0];
    await client.query(`INSERT INTO content.receipt (operation_id, request_digest, action, outcome,
      variant_id, revision_id, data_epoch, sequence)
      VALUES ($1, $2, $3, 'succeeded', $4, $5, $6, $7)`,
    [admission.id, admission.requestDigest, action, variantId, revisionId, data_epoch, sequence]);
    await client.query(`INSERT INTO content.outbox (id, data_epoch, sequence, operation_id,
      event_type, recipe, revision_id, payload)
      VALUES ($1, $2, $3, $4, $5, 'realm-reply-v1', $6, $7::jsonb)`,
    [randomUUID(), data_epoch, sequence, admission.id, eventType, revisionId, JSON.stringify(payload)]);
  }

  async readReply(reply: string): Promise<ReplyIdentityInput | null> {
    if (!native.test(reply)) throw new RealmReplyInvalid('invalid reply ID');
    const result = await this.pool.query<{
      id: string; variant_id: string; revision_id: string; author: string;
      root_target: string; root_revision: string; origin_realm: string | null;
      parent_reply: string | null; parent_revision: string | null; context_revision: string | null;
    }>(`SELECT p.id, p.variant_id, r.revision_id::text, p.author,
      p.root_target, p.root_revision, p.origin_realm, p.parent_reply, p.parent_revision::text,
      p.context_revision FROM content.reply p
      JOIN content.receipt r ON r.operation_id = p.operation_id WHERE p.id = $1`, [reply]);
    const row = result.rows[0];
    if (!row) return null;
    return { reply: row.id, variantId: row.variant_id, revisionId: row.revision_id,
      author: row.author, rootTarget: row.root_target, rootRevision: row.root_revision, originRealm: row.origin_realm,
      parentReply: row.parent_reply, parentRevision: row.parent_revision,
      contextRevision: row.context_revision };
  }

  /** The operation lock orders cancellation against an uncertain identity
   * insert, so replay cannot publish an identity after Access sealed denial. */
  async cancelCreate(admission: RegisteredAdmission): Promise<boolean> {
    if (admission.action !== 'reply.create') throw new RealmReplyDenied('wrong reply action');
    return this.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`realm-reply:${admission.id}`]);
      const prior = (await client.query<Receipt>('SELECT action, request_digest, outcome FROM content.receipt WHERE operation_id = $1', [admission.id])).rows[0];
      if (prior) {
        if (prior.action !== 'reply.create' || prior.request_digest !== admission.requestDigest) throw new RealmReplyConflict('reply cancellation differs');
        return prior.outcome === 'succeeded';
      }
      const position = (await client.query<{ data_epoch: string; sequence: string }>(`
        UPDATE content.owner_control SET sequence = sequence + 1 WHERE singleton
        RETURNING data_epoch, sequence::text`)).rows[0];
      if (!position) throw new RealmReplyUnavailable('Content owner position is absent');
      await client.query(`INSERT INTO content.receipt
        (operation_id, request_digest, action, outcome, data_epoch, sequence)
        VALUES ($1,$2,'reply.create','rejected',$3,$4)`, [admission.id, admission.requestDigest, position.data_epoch, position.sequence]);
      await client.query(`INSERT INTO content.outbox
        (id, data_epoch, sequence, operation_id, event_type, recipe, payload)
        VALUES ($1,$2,$3,$4,'content.reply.cancelled','realm-reply-v1','{}')`,
      [randomUUID(), position.data_epoch, position.sequence, admission.id]);
      return false;
    });
  }

  async createReply(admission: RegisteredAdmission, input: ReplyIdentityInput): Promise<ReplyIdentity> {
    assertIdentity(input);
    if (admission.action !== 'reply.create'
      || admission.scope !== `reply:create:${input.rootTarget}`
      || admission.actingSubject !== input.author) {
      throw new RealmReplyDenied('reply admission differs from author and target');
    }
    return this.transaction(async client => {
      if (await this.prior(client, admission, 'reply.create')) return { ...input, replayed: true };
      const variant = await client.query<{ resource_id: string; draft_head: string }>(`
        SELECT resource_id, draft_head::text FROM content.variant WHERE id = $1 FOR UPDATE`, [input.variantId]);
      if (variant.rows[0]?.resource_id !== input.reply
        || variant.rows[0]?.draft_head !== input.revisionId) {
        throw new RealmReplyStale('reply body head or identity changed');
      }
      const author = await client.query<{ origin_realm: string | null }>(`SELECT origin_realm FROM content.reply_author
        WHERE reply = $1 AND variant_id = $2 AND author = $3 AND root_target = $4 AND root_revision = $5`,
      [input.reply, input.variantId, input.author, input.rootTarget, input.rootRevision]);
      if (!author.rowCount) throw new RealmReplyDenied('reply has no matching admitted author provenance');
      if (input.originRealm !== undefined && input.originRealm !== author.rows[0]!.origin_realm) {
        throw new RealmReplyDenied('reply origin differs from its first draft');
      }
      const revision = await client.query(`SELECT 1 FROM content.revision WHERE variant_id = $1
        AND id = $2 AND availability = 'available' AND model = 'member-reply-v1'
        AND provenance->>'author' = $3 AND body->>'deleted' = 'false'`, [input.variantId, input.revisionId, input.author]);
      if (!revision.rowCount) throw new RealmReplyStale('reply revision is unavailable');
      if (input.parentReply) {
        const parent = await client.query<{ root_target: string; root_revision: string; origin_realm: string | null }>(`
          SELECT p.root_target, p.root_revision, p.origin_realm FROM content.reply p
          JOIN content.variant v ON v.id = p.variant_id
          JOIN content.revision head ON head.id = v.draft_head AND head.availability = 'available'
            AND head.body->>'deleted' = 'false'
          JOIN content.revision r ON r.variant_id = p.variant_id
          WHERE p.id = $1 AND r.id = $2 AND r.availability = 'available'`,
        [input.parentReply, input.parentRevision]);
        if (!parent.rows[0] || parent.rows[0].root_target !== input.rootTarget
          || parent.rows[0].root_revision !== input.rootRevision
          || parent.rows[0].origin_realm !== author.rows[0]!.origin_realm) {
          throw new RealmReplyDenied('parent is not an exact reply to this root');
        }
      }
      await this.receipt(client, admission, 'reply.create', input.variantId, input.revisionId,
        'content.reply.created', { reply: input.reply, rootTarget: input.rootTarget });
      await client.query(`INSERT INTO content.reply (id, variant_id, author, root_target,
          root_revision, parent_reply, parent_variant, parent_revision, context_revision, operation_id, origin_realm)
        VALUES ($1, $2, $3, $4, $5, $6,
          (SELECT variant_id FROM content.reply WHERE id = $6), $7, $8, $9, $10)`,
      [input.reply, input.variantId, input.author, input.rootTarget, input.rootRevision,
        input.parentReply, input.parentRevision, input.contextRevision, admission.id, author.rows[0]!.origin_realm]);
      return { ...input, replayed: false };
    });
  }

  async decideReview(admission: RegisteredAdmission, input: ReviewInput): Promise<ReviewDecision> {
    if (!native.test(input.realm) || !native.test(input.reply) || !uuid.test(input.revisionId)
      || !digest.test(input.revisionDigest) || !digest.test(input.dependencyDigest)
      || !/^(0|[1-9][0-9]{0,18})$/.test(input.expectedGeneration)
      || (input.supersedes !== null && !uuid.test(input.supersedes))
      || !['approved', 'rejected', 'unavailable', 'revoked'].includes(input.outcome)
      || !['human', 'ai'].includes(input.method)
      || !input.methodRevision || input.methodRevision.length > 300
      || (input.reasonReference !== null && (!input.reasonReference || input.reasonReference.length > 128))
      || (['rejected', 'revoked'].includes(input.outcome) && input.reasonReference === null)) {
      throw new RealmReplyInvalid('invalid review decision');
    }
    if (admission.action !== 'review.decide'
      || admission.scope !== `review:decide:${input.realm}`) {
      throw new RealmReplyDenied('review admission is for another Realm');
    }
    return this.transaction(async client => {
      if (await this.prior(client, admission, 'review.decide')) {
        const row = await client.query<{ id: string; review_generation: string }>(`
          SELECT id, review_generation FROM content.realm_review_decision WHERE operation_id = $1`, [admission.id]);
        if (!row.rows[0]) throw new RealmReplyUnavailable('review receipt has no decision');
        return { decisionId: row.rows[0].id, realm: input.realm, reply: input.reply,
          revisionId: input.revisionId, generation: row.rows[0].review_generation,
          outcome: input.outcome, revisionDigest: input.revisionDigest, replayed: true };
      }
      const reply = await client.query<{ variant_id: string; origin_realm: string | null }>(
        'SELECT variant_id,origin_realm FROM content.reply WHERE id = $1', [input.reply]);
      if (!reply.rows[0] || reply.rows[0].origin_realm && reply.rows[0].origin_realm !== input.realm) {
        throw new RealmReplyDenied('reply is unavailable in this Realm');
      }
      await client.query('SELECT id FROM content.variant WHERE id = $1 FOR UPDATE', [reply.rows[0].variant_id]);
      const revision = await client.query<{ byte_digest: string }>(`
        SELECT byte_digest FROM content.revision WHERE variant_id = $1 AND id = $2
          AND availability = 'available'`, [reply.rows[0].variant_id, input.revisionId]);
      if (revision.rows[0]?.byte_digest !== input.revisionDigest) {
        throw new RealmReplyStale('review does not bind the exact available bytes');
      }
      const prior = await client.query<{ id: string; review_generation: string; outcome: string }>(`
        SELECT id, review_generation, outcome FROM content.realm_review_decision
        WHERE realm = $1 AND revision_id = $2 ORDER BY review_generation DESC LIMIT 1`,
      [input.realm, input.revisionId]);
      const generation = (BigInt(prior.rows[0]?.review_generation ?? '0') + 1n).toString();
      if (input.expectedGeneration !== (prior.rows[0]?.review_generation ?? '0')
        || input.supersedes !== (prior.rows[0]?.id ?? null)
        || (input.outcome === 'revoked' && prior.rows[0]?.outcome !== 'approved')) {
        throw new RealmReplyStale('review chain changed');
      }
      const id = randomUUID();
      await this.receipt(client, admission, 'review.decide', reply.rows[0].variant_id,
        input.revisionId, 'content.realm-review.decided',
        { realm: input.realm, reply: input.reply, revisionId: input.revisionId, outcome: input.outcome });
      await client.query(`INSERT INTO content.realm_review_decision (id, realm, variant_id, revision_id,
          review_generation, supersedes, outcome, policy, policy_revision, method,
          method_revision, reviewer, revision_digest, dependency_digest, reason_reference, operation_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [id, input.realm, reply.rows[0].variant_id, input.revisionId, generation,
        input.supersedes, input.outcome, REVIEW_POLICY, admission.authorityEpoch,
        input.method, input.methodRevision, admission.actingSubject, input.revisionDigest,
        input.dependencyDigest, input.reasonReference, admission.id]);
      return { decisionId: id, realm: input.realm, reply: input.reply,
        revisionId: input.revisionId, generation, outcome: input.outcome,
        revisionDigest: input.revisionDigest, replayed: false };
    });
  }

  async currentReview(realm: string, reply: string, revisionId: string,
    reviewDecisionId?: string, preparationId?: string): Promise<boolean> {
    const result = await this.pool.query(`SELECT 1 FROM content.reply p
      JOIN content.variant v ON v.id = p.variant_id
      JOIN content.revision head ON head.id = v.draft_head AND head.availability = 'available'
        AND head.body->>'deleted' = 'false'
      JOIN content.realm_review_decision d ON d.variant_id = p.variant_id
      JOIN content.revision r ON r.variant_id = d.variant_id AND r.id = d.revision_id
      WHERE p.id = $1 AND d.realm = $2 AND d.revision_id = $3 AND d.outcome = 'approved'
        AND r.availability = 'available' AND ($4::uuid IS NULL OR d.id = $4)
        AND ($5::text IS NULL OR EXISTS (
          SELECT 1 FROM content.realm_placement_preparation placement
          JOIN content.publication_preparation publication ON publication.operation_id = placement.operation_id
          WHERE placement.operation_id = $5 AND placement.realm = d.realm
            AND placement.variant_id = p.variant_id AND placement.revision_id = d.revision_id
            AND placement.review_decision_id = d.id
            AND publication.status = 'active' AND publication.pin_active))
        AND NOT EXISTS (SELECT 1 FROM content.realm_review_decision later
          WHERE later.supersedes = d.id) LIMIT 1`, [reply, realm, revisionId, reviewDecisionId ?? null,
      preparationId ?? null]);
    return result.rowCount === 1;
  }

  /** Live keyset page, at most 32 visible comments and one lookahead row.
   * Exact-root index bounds traversal to this thread; no per-row owner calls. */
  async listCurrent(rootTarget: string, rootRevision: string, after?: string, realm: string | null = null) {
    if (![rootTarget, rootRevision].every(value => native.test(value))
      || (after && !native.test(after))) throw new RealmReplyInvalid('invalid reply page');
    const rows = await this.pool.query(`WITH candidates AS (
      SELECT * FROM content.reply WHERE root_target = $1 AND root_revision = $2 AND id > $3
        AND origin_realm IS NOT DISTINCT FROM $4
      ORDER BY id LIMIT 33
    ) SELECT p.id AS reply, p.author, p.origin_realm AS "originRealm",
      p.root_target AS "rootTarget", p.root_revision AS "rootRevision",
      p.parent_reply AS "parentReply", p.parent_revision AS "parentRevision",
      p.variant_id AS "variantId", r.id AS "revisionId", r.body->>'body' AS body,
      r.byte_digest AS "revisionDigest",
      (r.availability = 'available' AND r.body->>'deleted' = 'false') AS visible
      FROM candidates p JOIN content.variant v ON v.id = p.variant_id
      JOIN content.revision r ON r.id = v.draft_head
      ORDER BY p.id`, [rootTarget, rootRevision, after ?? '', realm]);
    const candidates = rows.rows.slice(0, 32);
    const items = candidates.filter(row => row.visible === true).map(({ visible: _visible, ...row }) => row);
    return { items, next: rows.rows.length > 32 ? candidates.at(-1)!.reply as string : null };
  }

  async readCurrent(reply: string) {
    if (!native.test(reply)) throw new RealmReplyInvalid('invalid reply');
    const row = (await this.pool.query<{ reply: string; author: string; rootTarget: string;
      rootRevision: string; variantId: string; revisionId: string; body: string; revisionDigest: string; originRealm: string | null }>(`
      SELECT p.id AS reply, p.author, p.origin_realm AS "originRealm", p.root_target AS "rootTarget", p.root_revision AS "rootRevision",
        p.variant_id AS "variantId", r.id AS "revisionId", r.body->>'body' AS body, r.byte_digest AS "revisionDigest"
      FROM content.reply p JOIN content.variant v ON v.id = p.variant_id
      JOIN content.revision r ON r.id = v.draft_head
      WHERE p.id = $1 AND r.availability = 'available' AND r.body->>'deleted' = 'false'`, [reply])).rows[0];
    return row ?? null;
  }

  async preparePlacement(admission: RegisteredAdmission,
    input: PlacementInput, directPolicyRevision?: string,
    directPolicy = 'https://rezics.com/definition/realm-members-direct-v1'): Promise<PlacementPreparation> {
    if (!native.test(input.realm) || !native.test(input.reply) || !uuid.test(input.revisionId)
      || (input.reviewDecisionId !== null && !uuid.test(input.reviewDecisionId)) || !digest.test(input.revisionDigest)
      || (input.expectedHead !== null && !native.test(input.expectedHead))) {
      throw new RealmReplyInvalid('invalid placement');
    }
    if (admission.action !== 'reply.place' || admission.scope !== `reply:place:${input.realm}`) {
      throw new RealmReplyDenied('placement admission is for another Realm');
    }
    return this.transaction(async client => {
      if (await this.prior(client, admission, 'publication.prepare')) {
        const found = await this.placement(client, admission.id);
        if (!found) throw new RealmReplyUnavailable('placement preparation is absent');
        return { ...found, replayed: true };
      }
      const reply = await client.query<{ variant_id: string; author: string; root_target: string;
        root_revision: string; parent_reply: string | null; parent_revision: string | null;
        context_revision: string | null; origin_realm: string | null }>(`SELECT variant_id, author, root_target, root_revision,origin_realm,
          parent_reply, parent_revision::text, context_revision FROM content.reply WHERE id = $1`, [input.reply]);
      if (!reply.rows[0] || reply.rows[0].origin_realm && reply.rows[0].origin_realm !== input.realm) {
        throw new RealmReplyDenied('reply is unavailable in this Realm');
      }
      const row = reply.rows[0];
      if (row.origin_realm && row.origin_realm !== input.realm) throw new RealmReplyDenied('Realm-origin reply cannot be republished in another Realm');
      await client.query('SELECT id FROM content.variant WHERE id = $1 FOR UPDATE', [row.variant_id]);
      const exact = await client.query<{ byte_digest: string }>(`SELECT byte_digest FROM content.revision
        WHERE variant_id = $1 AND id = $2 AND availability = 'available'`,
      [row.variant_id, input.revisionId]);
      if (exact.rows[0]?.byte_digest !== input.revisionDigest) {
        throw new RealmReplyStale('reply revision bytes changed or are unavailable');
      }
      let reviewDecisionId = input.reviewDecisionId;
      if (reviewDecisionId === null) {
        if (!directPolicyRevision || row.author !== admission.actingSubject) {
          throw new RealmReplyDenied('Realm policy requires moderator approval');
        }
        const latest = (await client.query<{ id: string; outcome: string }>(`
          SELECT id, outcome FROM content.realm_review_decision
          WHERE realm = $1 AND revision_id = $2 ORDER BY review_generation DESC LIMIT 1`,
        [input.realm, input.revisionId])).rows[0];
        if (latest && latest.outcome !== 'approved') {
          throw new RealmReplyDenied('A moderator decision prevents direct placement');
        }
        reviewDecisionId = latest?.id ?? randomUUID();
        if (!latest) {
          const proof = createHash('sha256').update(JSON.stringify({ admission: admission.id,
            requestDigest: admission.requestDigest, directPolicyRevision })).digest('hex');
          const policyAdmission = { ...admission, id: `${admission.id}:policy-review`, requestDigest: proof };
          await this.receipt(client, policyAdmission, 'review.decide', row.variant_id, input.revisionId,
            'content.realm-review.decided', { realm: input.realm, reply: input.reply,
              revisionId: input.revisionId, outcome: 'approved' });
          await client.query(`INSERT INTO content.realm_review_decision
            (id, realm, variant_id, revision_id, review_generation, outcome, policy, policy_revision,
             method, method_revision, reviewer, revision_digest, dependency_digest, operation_id)
            VALUES ($1,$2,$3,$4,1,'approved',$10,
              $5,'policy',$5,$6,$7,$8,$9)`, [reviewDecisionId, input.realm, row.variant_id,
            input.revisionId, directPolicyRevision, admission.actingSubject, input.revisionDigest,
            proof, policyAdmission.id, directPolicy]);
        }
      }
      const approval = await client.query<{ request_digest: string; method: string; policy_revision: string }>(`SELECT c.request_digest, d.method, d.policy_revision
        FROM content.realm_review_decision d
        JOIN content.receipt c ON c.operation_id = d.operation_id
        WHERE d.id = $1 AND d.realm = $2 AND d.revision_id = $3 AND d.variant_id = $4
          AND d.revision_digest = $5 AND d.outcome = 'approved'
          AND NOT EXISTS (SELECT 1 FROM content.realm_review_decision later
            WHERE later.supersedes = d.id)`,
      [reviewDecisionId, input.realm, input.revisionId, row.variant_id, input.revisionDigest]);
      if (!approval.rowCount) throw new RealmReplyStale('exact current approval is required');
      const policyRevision = directPolicyRevision ?? (approval.rows[0].method === 'policy'
        ? approval.rows[0].policy_revision : undefined);
      await client.query(`INSERT INTO content.publication_preparation
        (operation_id, revision_id, request_digest) VALUES ($1, $2, $3)`,
      [admission.id, input.revisionId, admission.requestDigest]);
      await client.query(`INSERT INTO content.realm_placement_preparation
        (operation_id, realm, variant_id, revision_id, review_decision_id, direct_policy_revision)
        VALUES ($1, $2, $3, $4, $5, $6)`,
      [admission.id, input.realm, row.variant_id, input.revisionId, reviewDecisionId, policyRevision ?? null]);
      await this.receipt(client, admission, 'publication.prepare', row.variant_id,
        input.revisionId, 'content.realm-reply.prepared',
        { realm: input.realm, reply: input.reply, revisionId: input.revisionId,
          reviewDecisionId });
      const position = await client.query<{ data_epoch: string; sequence: string }>(
        'SELECT data_epoch::text, sequence::text FROM content.receipt WHERE operation_id = $1',
        [admission.id]);
      return { ...(policyRevision ? { directPolicyRevision: policyRevision } : {}),
        operationId: admission.id, realm: input.realm, reply: input.reply,
        revisionId: input.revisionId, revisionDigest: input.revisionDigest,
        reviewDecisionId, reviewDigest: approval.rows[0].request_digest,
        ownerDataEpoch: position.rows[0]!.data_epoch, ownerSequence: position.rows[0]!.sequence,
        author: row.author,
        rootTarget: row.root_target, rootRevision: row.root_revision,
        parentReply: row.parent_reply, parentRevision: row.parent_revision,
        contextRevision: row.context_revision, replayed: false };
    });
  }

  private async placement(client: PoolClient, operationId: string): Promise<Omit<PlacementPreparation, 'replayed'> | null> {
    const result = await client.query<{ direct_policy_revision: string | null; realm: string; revision_id: string; review_decision_id: string;
      request_digest: string; data_epoch: string; sequence: string;
      byte_digest: string; id: string; author: string; root_target: string; root_revision: string;
      parent_reply: string | null; parent_revision: string | null; context_revision: string | null }>(`
      SELECT p.direct_policy_revision, p.realm, p.revision_id::text, p.review_decision_id::text, c.request_digest, r.byte_digest,
        prep.data_epoch::text, prep.sequence::text,
        i.id, i.author, i.root_target, i.root_revision, i.parent_reply,
        i.parent_revision::text, i.context_revision
      FROM content.realm_placement_preparation p
      JOIN content.revision r ON r.id = p.revision_id
      JOIN content.realm_review_decision d ON d.id = p.review_decision_id
      JOIN content.receipt c ON c.operation_id = d.operation_id
      JOIN content.receipt prep ON prep.operation_id = p.operation_id
      JOIN content.reply i ON i.variant_id = p.variant_id
      WHERE p.operation_id = $1`, [operationId]);
    const row = result.rows[0];
    if (!row) return null;
    return { ...(row.direct_policy_revision ? { directPolicyRevision: row.direct_policy_revision } : {}),
      operationId, realm: row.realm, reply: row.id, revisionId: row.revision_id,
      revisionDigest: row.byte_digest, reviewDecisionId: row.review_decision_id,
      reviewDigest: row.request_digest,
      ownerDataEpoch: row.data_epoch, ownerSequence: row.sequence,
      author: row.author, rootTarget: row.root_target, rootRevision: row.root_revision,
      parentReply: row.parent_reply, parentRevision: row.parent_revision,
      contextRevision: row.context_revision };
  }

  async readPlacement(operationId: string): Promise<PlacementPreparation | null> {
    const client = await this.pool.connect();
    try {
      const row = await this.placement(client, operationId);
      return row ? { ...row, replayed: true } : null;
    } finally { client.release(); }
  }
}
