import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { RealmReplyConflict, RealmReplyInvalid, RealmReplyStale, RealmReplyUnavailable } from './content-store.ts';

const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The digest binds the complete client intent, including omitted fields. It
 * excludes the server's canonical selection, which can retain an older root. */
export interface AboutPostIntent {
  realm: string; about: string; actor: string; intentKey: string;
  intentDigest: string; rootRevision: string;
}
export interface AboutThread {
  realm: string; about: string; openerReply: string; rootRevision: string;
  revisionId: string | null; state: 'reserved' | 'active';
}
export interface AboutPostOperation extends Omit<AboutPostIntent, 'rootRevision'> {
  id: string; reply: string; variantId: string; rootRevision: string;
  openerReply: string; parentReply: string | null; parentRevision: string | null;
  phase: 'selected' | 'drafted' | 'identified' | 'posted';
  revisionId: string | null; draftOperationId: string | null;
  identityOperationId: string | null; placementOperationId: string | null;
  placementReceipt: string | null; pending: boolean; replayed: boolean;
}
interface OperationRow {
  id: string; realm: string; about: string; actor: string; intent_key: string; intent_digest: string;
  requested_root_revision: string;
  reply: string; variant_id: string; root_revision: string; opener_reply: string;
  parent_reply: string | null; parent_revision: string | null;
  phase: AboutPostOperation['phase']; revision_id: string | null; draft_operation_id: string | null;
  identity_operation_id: string | null; placement_operation_id: string | null; placement_receipt: string | null;
}
function operation(row: OperationRow, replayed: boolean): AboutPostOperation {
  return { id: row.id, realm: row.realm, about: row.about, actor: row.actor,
    intentKey: row.intent_key, intentDigest: row.intent_digest, reply: row.reply, variantId: row.variant_id,
    rootRevision: row.root_revision, openerReply: row.opener_reply,
    parentReply: row.parent_reply, parentRevision: row.parent_revision, phase: row.phase,
    revisionId: row.revision_id, draftOperationId: row.draft_operation_id,
    identityOperationId: row.identity_operation_id, placementOperationId: row.placement_operation_id,
    placementReceipt: row.placement_receipt,
    pending: row.parent_reply !== null && row.parent_revision === null, replayed };
}
function assertReference(value: string, maximum = 300): void {
  if (!value || value.length > maximum || value.includes('\0')) throw new RealmReplyInvalid('invalid discussion reference');
}
function assertOperationId(id: string): void {
  if (!uuid.test(id)) throw new RealmReplyInvalid('invalid discussion operation');
}

/** Durable progress only: admission and placement decisions retain their owners.
 * No transaction callback escapes to ContentCore, Access or Jena. */
export class RealmAboutThreadStore {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED; SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '5s'");
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
      if (error && typeof error === 'object' && 'code' in error
        && ['40001', '40P01', '55P03', '57014'].includes(String(error.code))) {
        throw new RealmReplyUnavailable('Content owner lock budget exhausted');
      }
      throw error;
    } finally { client.release(); }
  }

  private async selected(client: PoolClient, id: string): Promise<OperationRow> {
    const row = (await client.query<OperationRow>(
      'SELECT * FROM content.realm_about_post_operation WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!row) throw new RealmReplyStale('discussion operation is missing');
    return row;
  }

  private async resolve(client: PoolClient, row: OperationRow): Promise<OperationRow> {
    if (row.parent_reply !== null && row.parent_revision === null) {
      // A committed reservation is visible even before its identity exists.
      // Never infer readiness from a draft or an identity alone.
      const thread = (await client.query<{ state: AboutThread['state']; revision_id: string | null }>(
        'SELECT state, revision_id FROM content.realm_about_thread WHERE realm = $1 AND about = $2',
        [row.realm, row.about])).rows[0];
      if (thread?.state === 'active') {
        row = (await client.query<OperationRow>(`UPDATE content.realm_about_post_operation
          SET parent_revision = $2 WHERE id = $1 RETURNING *`, [row.id, thread.revision_id])).rows[0]!;
      }
    }
    return row;
  }

  async reserve(input: AboutPostIntent): Promise<AboutPostOperation> {
    if (![input.realm, input.about, input.actor].every(value => native.test(value))
      || !/^[0-9a-f]{64}$/.test(input.intentDigest)) throw new RealmReplyInvalid('invalid discussion intent');
    assertReference(input.intentKey, 128);
    assertReference(input.rootRevision);
    return this.transaction(async client => {
      // Serialize retries of one actor's key independently of the canonical key.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify(['realm-about-intent', input.actor, input.intentKey])]);
      const prior = (await client.query<OperationRow>(`SELECT * FROM content.realm_about_post_operation
        WHERE actor = $1 AND intent_key = $2 FOR UPDATE`, [input.actor, input.intentKey])).rows[0];
      if (prior) {
        if (prior.intent_digest !== input.intentDigest || prior.realm !== input.realm || prior.about !== input.about
          || prior.requested_root_revision !== input.rootRevision) {
          throw new RealmReplyConflict('discussion intent key binds different input');
        }
        return operation(await this.resolve(client, prior), true);
      }
      const id = randomUUID(), reply = `https://rezics.com/id/${randomUUID()}`;
      const variantId = `urn:rezics:variant:${randomUUID()}`;
      await client.query(`INSERT INTO content.realm_about_thread (realm, about, opener_reply, root_revision)
        VALUES ($1,$2,$3,$4) ON CONFLICT (realm, about) DO NOTHING`,
      [input.realm, input.about, reply, input.rootRevision]);
      // A separate READ COMMITTED statement sees a winner that was outside the
      // INSERT snapshot: https://www.postgresql.org/docs/current/transaction-iso.html
      const thread = (await client.query<{ opener_reply: string; root_revision: string; revision_id: string | null; state: AboutThread['state'] }>(
        'SELECT opener_reply, root_revision, revision_id, state FROM content.realm_about_thread WHERE realm = $1 AND about = $2 FOR SHARE',
        [input.realm, input.about])).rows[0];
      if (!thread) throw new RealmReplyUnavailable('canonical reservation is unavailable');
      const parent = thread.opener_reply === reply ? null : thread.opener_reply;
      const row = (await client.query<OperationRow>(`INSERT INTO content.realm_about_post_operation
        (id, actor, intent_key, intent_digest, realm, about, reply, variant_id,
         opener_reply, root_revision, parent_reply, parent_revision, requested_root_revision)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [id, input.actor, input.intentKey, input.intentDigest, input.realm, input.about, reply, variantId,
        thread.opener_reply, thread.root_revision, parent, parent ? thread.revision_id : null, input.rootRevision])).rows[0]!;
      return operation(row, false);
    });
  }

  async resume(id: string): Promise<AboutPostOperation> {
    assertOperationId(id);
    return this.transaction(async client => operation(await this.resolve(client, await this.selected(client, id)), true));
  }

  /** Owner lookup includes reservations and hidden openers. Disclosure belongs
   * to the later lookup command, and must not delete or reallocate this key. */
  async readThread(realm: string, about: string): Promise<AboutThread | null> {
    if (![realm, about].every(value => native.test(value))) throw new RealmReplyInvalid('invalid discussion key');
    return this.transaction(async client => {
      const row = (await client.query<{ realm: string; about: string; opener_reply: string;
        root_revision: string; revision_id: string | null; state: AboutThread['state'] }>(
        'SELECT * FROM content.realm_about_thread WHERE realm = $1 AND about = $2', [realm, about])).rows[0];
      return row ? { realm: row.realm, about: row.about, openerReply: row.opener_reply,
        rootRevision: row.root_revision, revisionId: row.revision_id, state: row.state } : null;
    });
  }

  async recordDraft(id: string, draftOperationId: string): Promise<AboutPostOperation> {
    assertOperationId(id);
    assertReference(draftOperationId);
    return this.transaction(async client => {
      const row = await this.resolve(client, await this.selected(client, id));
      if (row.draft_operation_id) {
        if (row.draft_operation_id !== draftOperationId) throw new RealmReplyConflict('discussion draft receipt differs');
        return operation(row, true);
      }
      if (row.parent_reply && !row.parent_revision) throw new RealmReplyUnavailable('canonical opener is pending');
      const draft = (await client.query<{ revision_id: string }>(`SELECT c.revision_id FROM content.receipt c
        JOIN content.revision r ON r.id = c.revision_id AND r.variant_id = c.variant_id
        JOIN content.reply_author a ON a.variant_id = c.variant_id
        WHERE c.operation_id = $1 AND c.action = 'draft.save' AND c.outcome = 'succeeded'
          AND c.variant_id = $2 AND a.reply = $3 AND a.author = $4
          AND a.operation_id = c.operation_id
          AND a.root_target = $5 AND a.root_revision = $6 AND a.origin_realm = $7
          AND r.availability = 'available' AND r.model = 'member-reply-v1'`,
      [draftOperationId, row.variant_id, row.reply, row.actor, row.about, row.root_revision, row.realm])).rows[0];
      if (!draft) throw new RealmReplyStale('discussion draft receipt is missing or differs');
      const saved = (await client.query<OperationRow>(`UPDATE content.realm_about_post_operation
        SET phase = 'drafted', draft_operation_id = $2, revision_id = $3 WHERE id = $1 RETURNING *`,
      [id, draftOperationId, draft.revision_id])).rows[0]!;
      return operation(saved, false);
    });
  }

  /** Call only after resolving the immutable successful graph placement receipt.
   * This records the owner's decision; it neither authorizes nor places a reply.
   * Unknown/refused effects keep the reservation pending for owner recovery. */
  async recordPosted(id: string, placementOperationId: string, placementReceipt: string): Promise<AboutPostOperation> {
    assertOperationId(id);
    assertReference(placementOperationId);
    if (!native.test(placementReceipt)) throw new RealmReplyInvalid('invalid placement receipt');
    return this.transaction(async client => {
      const row = await this.selected(client, id);
      if (row.phase === 'posted') {
        if (row.placement_operation_id !== placementOperationId || row.placement_receipt !== placementReceipt) {
          throw new RealmReplyConflict('discussion placement receipt differs');
        }
        return operation(row, true);
      }
      if (row.phase !== 'identified') throw new RealmReplyStale('discussion identity is pending');
      const preparation = await client.query(`SELECT 1 FROM content.realm_placement_preparation
        WHERE operation_id = $1 AND realm = $2 AND variant_id = $3 AND revision_id = $4`,
      [placementOperationId, row.realm, row.variant_id, row.revision_id]);
      if (!preparation.rowCount) throw new RealmReplyStale('discussion placement preparation differs');
      const saved = (await client.query<OperationRow>(`UPDATE content.realm_about_post_operation
        SET phase = 'posted', placement_operation_id = $2, placement_receipt = $3 WHERE id = $1 RETURNING *`,
      [id, placementOperationId, placementReceipt])).rows[0]!;
      if (row.reply === row.opener_reply) {
        await client.query(`UPDATE content.realm_about_thread SET state = 'active', revision_id = $3
          WHERE realm = $1 AND about = $2`, [row.realm, row.about, row.revision_id]);
      }
      return operation(saved, false);
    });
  }
}
