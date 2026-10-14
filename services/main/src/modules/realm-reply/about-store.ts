import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { RealmReplyConflict, RealmReplyInvalid, RealmReplyStale, RealmReplyUnavailable } from './content-store.ts';
import type { RealmReplyDispatchBasis, ReplyGraphReceipt } from './graph.ts';

const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const principalIntentKey = (principal: string, key: string) =>
  createHash('sha256').update(JSON.stringify(['realm-about-post', principal, key])).digest('hex');

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
export interface AboutTerminalOutcome {
  kind: 'reply-denied' | 'reply-invalid' | 'reply-stale' | 'admission-denied'
    | 'draft-denied' | 'draft-rights-denied' | 'draft-stale' | 'content-conflict'
    | 'target-not-bound' | 'target-unavailable' | 'read-missing' | 'read-moved' | 'read-invalid';
  message: string;
}
export type AboutRefusalOutcome = { kind: 'absent' }
  | { kind: 'refused' | 'recoverable' | 'posted'; operation: AboutPostOperation };
export interface AboutPostOperation extends Omit<AboutPostIntent, 'rootRevision'> {
  id: string; reply: string; variantId: string; rootRevision: string;
  openerReply: string; parentReply: string | null; parentRevision: string | null;
  phase: 'selected' | 'drafted' | 'identified' | 'posted';
  revisionId: string | null; draftOperationId: string | null;
  identityOperationId: string | null; placementOperationId: string | null;
  placementReceipt: string | null; pending: boolean; replayed: boolean;
  terminalRefusal: boolean; placementAdmissionId: string | null; dispatchBasis: RealmReplyDispatchBasis | null;
  terminalOutcome: AboutTerminalOutcome | null;
}
interface OperationRow {
  id: string; realm: string; about: string; actor: string; intent_key: string; intent_digest: string;
  requested_root_revision: string;
  reply: string; variant_id: string; root_revision: string; opener_reply: string;
  parent_reply: string | null; parent_revision: string | null;
  phase: AboutPostOperation['phase']; revision_id: string | null; draft_operation_id: string | null;
  identity_operation_id: string | null; placement_operation_id: string | null; placement_receipt: string | null;
  terminal_refusal: boolean; placement_admission_id: string | null; dispatch_zone: string | null;
  dispatch_zone_revision: string | null; dispatch_route_revision: string | null;
  terminal_outcome: AboutTerminalOutcome | null;
}
function operation(row: OperationRow, replayed: boolean): AboutPostOperation {
  return { id: row.id, realm: row.realm, about: row.about, actor: row.actor,
    intentKey: row.intent_key, intentDigest: row.intent_digest, reply: row.reply, variantId: row.variant_id,
    rootRevision: row.root_revision, openerReply: row.opener_reply,
    parentReply: row.parent_reply, parentRevision: row.parent_revision, phase: row.phase,
    revisionId: row.revision_id, draftOperationId: row.draft_operation_id,
    identityOperationId: row.identity_operation_id, placementOperationId: row.placement_operation_id,
    placementReceipt: row.placement_receipt,
    terminalRefusal: row.terminal_refusal, placementAdmissionId: row.placement_admission_id,
    terminalOutcome: row.terminal_outcome,
    dispatchBasis: row.dispatch_zone ? { zone: row.dispatch_zone,
      zoneRevision: row.dispatch_zone_revision!, routeRevision: row.dispatch_route_revision! } : null,
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
    if (row.terminal_refusal) throw new RealmReplyStale('Discussion intent was refused before placement');
    const canonical = (await client.query<{ opener_reply: string }>(
      'SELECT opener_reply FROM content.realm_about_thread WHERE realm=$1 AND about=$2 FOR SHARE',
      [row.realm, row.about])).rows[0];
    if (!canonical || canonical.opener_reply !== row.opener_reply) {
      throw new RealmReplyStale('Discussion reservation was released');
    }
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

  async readIntent(principal: string, key: string, digest: string): Promise<AboutPostOperation | null> {
    const rows = (await this.pool.query<OperationRow>(`SELECT * FROM content.realm_about_post_operation
      WHERE intent_key = $1 LIMIT 2`, [principalIntentKey(principal, key)])).rows;
    if (rows.length > 1) throw new RealmReplyUnavailable('discussion intent is ambiguous');
    const row = rows[0];
    if (!row) return null;
    if (row.intent_digest !== digest) throw new RealmReplyConflict('discussion intent key binds different input');
    return operation(row, true);
  }

  async reserve(input: AboutPostIntent, principal?: string): Promise<AboutPostOperation> {
    if (![input.realm, input.about, input.actor].every(value => native.test(value))
      || !/^[0-9a-f]{64}$/.test(input.intentDigest)) throw new RealmReplyInvalid('invalid discussion intent');
    assertReference(input.intentKey, 128);
    assertReference(input.rootRevision);
    const storedKey = principal ? principalIntentKey(principal, input.intentKey) : input.intentKey;
    return this.transaction(async client => {
      // Serialize retries of one principal's key independently of the canonical
      // key; legacy callers retain their actor-scoped owner key.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify(['realm-about-intent', principal ?? input.actor, storedKey])]);
      const prior = (await client.query<OperationRow>(`SELECT * FROM content.realm_about_post_operation
        WHERE ${principal ? 'intent_key = $1' : 'actor = $1 AND intent_key = $2'} FOR UPDATE`,
      principal ? [storedKey] : [input.actor, storedKey])).rows[0];
      if (prior) {
        if (prior.actor !== input.actor || prior.intent_digest !== input.intentDigest || prior.realm !== input.realm || prior.about !== input.about
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
      [id, input.actor, storedKey, input.intentDigest, input.realm, input.about, reply, variantId,
        thread.opener_reply, thread.root_revision, parent, parent ? thread.revision_id : null, input.rootRevision])).rows[0]!;
      return operation(row, false);
    });
  }

  async resume(id: string): Promise<AboutPostOperation> {
    assertOperationId(id);
    return this.transaction(async client => operation(await this.resolve(client, await this.selected(client, id)), true));
  }

  /** The immutable graph receipt distinguishes a cancelled reservation from
   * an in-flight opener. */
  async openingPlacement(selected: Pick<AboutPostOperation, 'openerReply'>): Promise<string | null> {
    const rows = (await this.pool.query<{ placement_admission_id: string | null }>(`
      SELECT placement_admission_id FROM content.realm_about_post_operation WHERE reply=$1 LIMIT 2`,
    [selected.openerReply])).rows;
    if (rows.length !== 1) throw new RealmReplyUnavailable('discussion opener operation is unavailable');
    return rows[0]!.placement_admission_id;
  }

  /** Read the exact cancellation emitted by the existing draft bridge. A
   * receipt for another request or a missing receipt is not a refusal proof. */
  async draftWasCancelled(admissionId: string, requestDigest: string): Promise<boolean> {
    const rows = (await this.pool.query<{ action: string; outcome: string; request_digest: string }>(
      'SELECT action,outcome,request_digest FROM content.receipt WHERE operation_id=$1 LIMIT 2',
      [`content-draft:${admissionId}`])).rows;
    if (rows.length > 1) throw new RealmReplyUnavailable('discussion draft cancellation is ambiguous');
    return rows.length === 1 && rows[0]!.action === 'draft.save'
      && rows[0]!.request_digest === requestDigest && rows[0]!.outcome === 'rejected';
  }

  /** Record a definite pre-dispatch refusal, preserving all owner effects.
   * The operation lock orders this with recordDispatch, including a registered
   * admission whose response was lost. Once dispatch is recorded, only its
   * graph cancellation can release the reservation. */
  async refuseBeforeDispatch(id: string, outcome: AboutTerminalOutcome): Promise<AboutRefusalOutcome> {
    assertOperationId(id);
    return this.transaction(async client => this.refuseSelected(client, await this.selected(client, id), outcome));
  }

  /** A refusal can race allocation even when the command's first read was empty.
   * An absent result rejects only this request, without settling the key or
   * fencing a later allocation. Selected and dispatched outcomes stay ordered
   * with reservation/dispatch by the existing intent and operation locks. */
  async refuseIntent(principal: string, key: string, digest: string,
    outcome: AboutTerminalOutcome): Promise<AboutRefusalOutcome> {
    const storedKey = principalIntentKey(principal, key);
    return this.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify(['realm-about-intent', principal, storedKey])]);
      const row = (await client.query<OperationRow>(`SELECT * FROM content.realm_about_post_operation
        WHERE intent_key=$1 FOR UPDATE`, [storedKey])).rows[0];
      if (!row) return { kind: 'absent' };
      if (row.intent_digest !== digest) throw new RealmReplyConflict('discussion intent key binds different input');
      return this.refuseSelected(client, row, outcome);
    });
  }

  private async refuseSelected(client: PoolClient, row: OperationRow,
    outcome: AboutTerminalOutcome): Promise<AboutRefusalOutcome> {
    if (row.terminal_outcome) return { kind: 'refused', operation: operation(row, true) };
    if (row.phase === 'posted') return { kind: 'posted', operation: operation(row, true) };
    if (row.placement_admission_id) return { kind: 'recoverable', operation: operation(row, true) };
    const canonical = (await client.query<{ opener_reply: string }>(
      'SELECT opener_reply FROM content.realm_about_thread WHERE realm=$1 AND about=$2 FOR UPDATE',
      [row.realm, row.about])).rows[0];
    // An undispatched selection from a replaced canonical key is fenced by
    // its immutable opener, so it can never dispatch. Retain that stale result
    // instead of allowing a newer target/policy cut to redefine its refusal.
    const retainedOutcome = !canonical || canonical.opener_reply !== row.opener_reply
      ? { kind: 'reply-stale' as const, message: 'Discussion reservation was released' } : outcome;
    const refused = (await client.query<OperationRow>(`UPDATE content.realm_about_post_operation
      SET terminal_refusal=true,terminal_outcome=$2 WHERE id=$1 RETURNING *`, [row.id, retainedOutcome])).rows[0]!;
    // A failed child retains the active opener. Only this selected opener
    // can relinquish an unactivated reservation.
    await client.query(`DELETE FROM content.realm_about_thread
      WHERE realm=$1 AND about=$2 AND opener_reply=$3 AND state='reserved'`,
    [row.realm, row.about, row.reply]);
    return { kind: 'refused', operation: operation(refused, true) };
  }

  /** Retain a native cancellation's response without marking it pre-dispatch. */
  async recordCancellation(id: string, receipt: ReplyGraphReceipt,
    outcome: AboutTerminalOutcome): Promise<AboutPostOperation> {
    assertOperationId(id);
    return this.transaction(async client => {
      const row = await this.selected(client, id);
      if (receipt.outcome !== 'cancelled' || receipt.admissionId !== row.placement_admission_id
        || receipt.scope !== `reply:place:${row.realm}` || row.phase === 'posted') {
        throw new RealmReplyUnavailable('Discussion cancellation receipt differs');
      }
      const saved = row.terminal_outcome ? row : (await client.query<OperationRow>(`UPDATE content.realm_about_post_operation
        SET terminal_outcome=$2 WHERE id=$1 RETURNING *`, [id, outcome])).rows[0]!;
      // Retaining the response and releasing its certified unsuccessful opener
      // are one transition, so a lost response cannot strand the reservation.
      await client.query(`DELETE FROM content.realm_about_thread
        WHERE realm=$1 AND about=$2 AND opener_reply=$3 AND state='reserved'`,
      [row.realm, row.about, row.reply]);
      return operation(saved, Boolean(row.terminal_outcome));
    });
  }

  /** Consume the placement owner's terminal cancellation, never its absence
   * or a caller's inference of expiry. Historical intent selections remain
   * immutable; activated keys are retained even when their opener is hidden. */
  async releaseReservation(selected: Pick<AboutPostOperation, 'realm' | 'about' | 'openerReply'>,
    terminal: ReplyGraphReceipt): Promise<boolean> {
    if (terminal.outcome !== 'cancelled' || terminal.scope !== `reply:place:${selected.realm}`) {
      throw new RealmReplyStale('Discussion reservation lacks a cancelled placement');
    }
    return this.transaction(async client => {
      const removed = await client.query(`DELETE FROM content.realm_about_thread t
        WHERE t.realm=$1 AND t.about=$2 AND t.opener_reply=$3 AND t.state='reserved'
          AND EXISTS (SELECT 1 FROM content.realm_about_post_operation o
            WHERE o.reply=t.opener_reply AND o.placement_admission_id=$4 AND o.phase='identified')`,
      [selected.realm, selected.about, selected.openerReply, terminal.admissionId]);
      return removed.rowCount === 1;
    });
  }

  /** Owner lookup includes reservations and hidden openers. Disclosure belongs
   * to the later lookup command; an activated key is never reallocated. Only
   * a definite pre-dispatch refusal or owner cancellation can release a reservation. */
  async readThread(realm: string, about: string): Promise<AboutThread | null> {
    if (![realm, about].every(value => native.test(value))) throw new RealmReplyInvalid('invalid discussion key');
    const rows = (await this.pool.query<{ realm: string | null; about: string | null; opener_reply: string | null;
      root_revision: string | null; revision_id: string | null; state: AboutThread['state'] | null }>(
      `SELECT t.realm,t.about,t.opener_reply,t.root_revision,t.revision_id,t.state
      FROM (VALUES (1)) AS probe(n) LEFT JOIN content.realm_about_thread t
        ON t.realm = $1 AND t.about = $2 LIMIT 2`, [realm, about])).rows;
    // The unique key owns selection. An absent key still returns one probe row;
    // neither corruption nor an unavailable owner may become an empty result.
    if (rows.length !== 1) throw new RealmReplyUnavailable('canonical discussion key is ambiguous');
    const row = rows[0]!;
    if (row.realm === null && row.about === null && row.opener_reply === null
      && row.root_revision === null && row.revision_id === null && row.state === null) return null;
    if (row.realm !== realm || row.about !== about || !row.opener_reply || !native.test(row.opener_reply)
      || !row.root_revision || row.root_revision.length > 300 || row.root_revision.includes('\0')
      || !row.state || !['reserved', 'active'].includes(row.state)
      || (row.state === 'active' ? !row.revision_id || !uuid.test(row.revision_id) : row.revision_id !== null)) {
      throw new RealmReplyUnavailable('canonical discussion key is malformed');
    }
    return { realm, about, openerReply: row.opener_reply,
      rootRevision: row.root_revision, revisionId: row.revision_id, state: row.state };
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
      if (!draft) throw new RealmReplyUnavailable('discussion draft receipt is missing or differs');
      const saved = (await client.query<OperationRow>(`UPDATE content.realm_about_post_operation
        SET phase = 'drafted', draft_operation_id = $2, revision_id = $3 WHERE id = $1 RETURNING *`,
      [id, draftOperationId, draft.revision_id])).rows[0]!;
      return operation(saved, false);
    });
  }

  /** Recover the draft's immutable receipt rather than inventing an admission id. */
  async recordDraftRevision(id: string, revisionId: string): Promise<AboutPostOperation> {
    const selected = await this.resume(id);
    const rows = (await this.pool.query<{ operation_id: string }>(`SELECT operation_id FROM content.receipt
      WHERE action = 'draft.save' AND outcome = 'succeeded' AND variant_id = $1 AND revision_id = $2 LIMIT 2`,
    [selected.variantId, revisionId])).rows;
    if (rows.length !== 1) throw new RealmReplyUnavailable('discussion draft receipt is unavailable');
    return this.recordDraft(id, rows[0]!.operation_id);
  }

  /** Resolve a lost draft response from the exact allocated variant's owner
   * receipt. The bridge need not be dispatched again, nor its authority renewed. */
  async savedDraft(selected: AboutPostOperation): Promise<{ revisionId: string; revisionDigest: string } | null> {
    const rows = (await this.pool.query<{ operation_id: string; revision_id: string; byte_digest: string }>(`
      SELECT c.operation_id,c.revision_id::text,r.byte_digest FROM content.receipt c
      JOIN content.revision r ON r.id=c.revision_id AND r.variant_id=c.variant_id
      WHERE c.variant_id=$1 AND c.action='draft.save' AND c.outcome='succeeded'
        AND ($2::text IS NULL OR c.operation_id=$2) LIMIT 2`,
    [selected.variantId, selected.draftOperationId])).rows;
    if (rows.length > 1) throw new RealmReplyUnavailable('discussion draft receipt is ambiguous');
    const row = rows[0];
    if (!row) return null;
    if (selected.draftOperationId) {
      if (row.revision_id !== selected.revisionId) throw new RealmReplyUnavailable('discussion draft receipt differs');
      // A recorded receipt is immutable. Recover native cancellation cleanup
      // even after another intent has replaced the released canonical key.
    } else await this.recordDraft(selected.id, row.operation_id);
    return { revisionId: row.revision_id, revisionDigest: row.byte_digest };
  }

  async recordDispatch(id: string, admissionId: string, basis: RealmReplyDispatchBasis): Promise<AboutPostOperation> {
    assertOperationId(id);
    assertReference(admissionId);
    if (![basis.zone, basis.zoneRevision, basis.routeRevision].every(value => native.test(value))) {
      throw new RealmReplyInvalid('invalid discussion dispatch basis');
    }
    return this.transaction(async client => {
      const row = await this.selected(client, id);
      if (row.terminal_outcome) return operation(row, true);
      if (row.placement_admission_id) {
        if (row.placement_admission_id !== admissionId) {
          throw new RealmReplyUnavailable('discussion dispatch admission differs');
        }
        // The first dispatch owns the server-observed basis. Same-admission
        // retries consume that cut, even across a Zone configuration change.
        return operation(row, true);
      }
      await this.resolve(client, row);
      if (row.phase !== 'identified') throw new RealmReplyStale('discussion identity is pending');
      return operation((await client.query<OperationRow>(`UPDATE content.realm_about_post_operation
        SET placement_admission_id=$2,dispatch_zone=$3,dispatch_zone_revision=$4,dispatch_route_revision=$5
        WHERE id=$1 RETURNING *`, [id, admissionId, basis.zone, basis.zoneRevision, basis.routeRevision])).rows[0]!, false);
    });
  }

  /** Call only after resolving the immutable successful graph placement receipt.
   * This records the owner's decision; it neither authorizes nor places a reply.
   * Unknown/refused effects keep the reservation pending for owner recovery. */
  async recordPosted(id: string, placementOperationId: string, placementReceipt: string): Promise<AboutPostOperation> {
    assertOperationId(id);
    assertReference(placementOperationId);
    if (!native.test(placementReceipt) && !/^urn:rezics:receipt:[0-9a-f]{64}$/.test(placementReceipt)) {
      throw new RealmReplyInvalid('invalid placement receipt');
    }
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
      if (!preparation.rowCount) throw new RealmReplyUnavailable('discussion placement preparation differs');
      const saved = (await client.query<OperationRow>(`UPDATE content.realm_about_post_operation
        SET phase = 'posted', placement_operation_id = $2, placement_receipt = $3 WHERE id = $1 RETURNING *`,
      [id, placementOperationId, placementReceipt])).rows[0]!;
      return operation(saved, false);
    });
  }
}
