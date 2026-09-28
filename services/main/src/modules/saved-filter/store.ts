import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { FilterDocument } from '../../../../../model/definitions/filter-document-v1.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { agentPattern, controlRead, controlTransaction, ControlConflict, ControlInvalid, ControlStale }
  from '../access/topology-control.ts';
import { followPrincipal } from '../follows/authority.ts';
import { commandKey } from '../follows/store.ts';
import { admitSavedFilter } from './admit.ts';
import { SAVED_FILTER_COST, SAVED_FILTER_PROFILE, type SavedFilterCreate, type SavedFilterDelete, type SavedFilterOrder,
  type SavedFilterReceipt, type SavedFilterUpdate } from './contract.ts';
import { homeFeedConditions } from './feed.ts';

/** The filter no longer exists for this reader, or never did. */
export class SavedFilterMissing extends Error {}
/** A followed Concept's filter is removed by unfollowing the Concept, which owns it. */
export class SavedFilterFollowed extends ControlConflict {}
/** Home already shows eight pinned tabs; one must be unpinned first. */
export class SavedFilterTabsFull extends ControlConflict {}

export interface SavedFilterRow {
  id: string; name: string | null; profile: typeof SAVED_FILTER_PROFILE; document: FilterDocument; facets: string[];
  context: 'global';
  concept: string | null; pin_position: number | null; revision: string;
}
const columns = 'id, name, profile, document, facets, context, concept, pin_position, revision';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function checkName(name: string) {
  if (name !== name.trim() || !name.length || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new ControlInvalid('A Saved Filter name is 1–80 printable characters');
  }
}

/** Refuses, as the Query's typed refusal, a pin Home's feed could not show, before any row changes. */
const pinnable = (document: FilterDocument) => { homeFeedConditions(document); };

type Command = { kind: 'create'; input: SavedFilterCreate } | { kind: 'update'; id: string; input: SavedFilterUpdate }
  | { kind: 'order'; input: SavedFilterOrder } | { kind: 'delete'; id: string; input: SavedFilterDelete };

/**
 * Saved Filters in Access, private to the verified person principal that
 * controls the acting Agent, as follows are. Pin positions stay contiguous
 * from 0; the deferred unique constraint lets one statement move them.
 */
export class SavedFilterStore {
  constructor(private readonly pool: Pool) {}

  /** Pinned filters in tab order, then the newest others: one inventory row and at most 101 filter rows. */
  async list(principal: VerifiedPrincipal, agent: string) {
    if (!agentPattern.test(agent)) throw new ControlInvalid('Invalid person Agent');
    return controlRead(this.pool, async client => {
      const owner = await followPrincipal(client, principal, agent);
      const inventory = (await client.query<{ revision: string }>(
        'SELECT revision FROM access.saved_filter_inventory WHERE principal_id = $1 FOR SHARE', [owner])).rows[0];
      const rows = (await client.query<SavedFilterRow>(`SELECT ${columns} FROM access.saved_filter
        WHERE principal_id = $1 ORDER BY pin_position NULLS LAST, created_at DESC, id LIMIT $2`,
      [owner, SAVED_FILTER_COST.listed + 1])).rows;
      return { revision: inventory?.revision ?? null, rows: rows.slice(0, SAVED_FILTER_COST.listed),
        complete: rows.length <= SAVED_FILTER_COST.listed };
    });
  }

  /** One filter by id for its reader; another reader's id reads as missing. */
  async read(principal: VerifiedPrincipal, agent: string, id: string): Promise<SavedFilterRow> {
    if (!agentPattern.test(agent) || !uuid.test(id)) throw new ControlInvalid('Invalid Saved Filter read');
    return controlRead(this.pool, async client => {
      const owner = await followPrincipal(client, principal, agent);
      const row = (await client.query<SavedFilterRow>(`SELECT ${columns} FROM access.saved_filter
        WHERE principal_id = $1 AND id = $2`, [owner, id])).rows[0];
      if (!row) throw new SavedFilterMissing('Saved Filter is unavailable');
      return row;
    });
  }

  create(principal: VerifiedPrincipal, input: SavedFilterCreate, key: string) {
    checkName(input.name);
    const admitted = admitSavedFilter(input.filter);
    if (input.pinned) pinnable(admitted.document);
    return this.command(principal, input.actingSubject, key, { kind: 'create', input }, async (client, owner) => {
      const inventory = (await client.query<{ named_count: number }>(
        'SELECT named_count FROM access.saved_filter_inventory WHERE principal_id = $1', [owner])).rows[0]!;
      if (inventory.named_count >= SAVED_FILTER_COST.named) throw new ControlInvalid('Saved Filter limit reached');
      const position = input.pinned ? await this.freeTab(client, owner) : null;
      const id = randomUUID(), revision = randomUUID();
      await client.query(`INSERT INTO access.saved_filter (id, principal_id, name, profile, document, facets,
        context, concept, pin_position, revision) VALUES ($1,$2,$3,$8,$4,$5,'global',NULL,$6,$7)`,
      [id, owner, input.name, admitted.document, admitted.facets, position, revision, SAVED_FILTER_PROFILE]);
      await client.query(`UPDATE access.saved_filter_inventory SET named_count = named_count + 1
        WHERE principal_id = $1`, [owner]);
      return { action: 'created' as const, id, filterRevision: revision };
    });
  }

  update(principal: VerifiedPrincipal, id: string, input: SavedFilterUpdate, key: string) {
    if (!uuid.test(id)) throw new ControlInvalid('Invalid Saved Filter');
    if (typeof input.name === 'string') checkName(input.name);
    if (input.name === undefined && input.pinned === undefined) throw new ControlInvalid('Nothing to change');
    return this.command(principal, input.actingSubject, key, { kind: 'update', id, input }, async (client, owner) => {
      const row = await this.locked(client, owner, id, input.expectedRevision);
      if (input.name === null && !row.concept) throw new ControlInvalid('A named filter keeps a name');
      let position = row.pin_position;
      if (input.pinned === true && position === null) {
        pinnable(row.document);
        position = await this.freeTab(client, owner);
      } else if (input.pinned === false && position !== null) {
        await this.unpin(client, owner, id, position);
        position = null;
      }
      const revision = randomUUID();
      await client.query(`UPDATE access.saved_filter SET name = $3, pin_position = $4, revision = $5,
        updated_at = clock_timestamp() WHERE principal_id = $1 AND id = $2`,
      [owner, id, input.name === undefined ? row.name : input.name, position, revision]);
      return { action: 'updated' as const, id, filterRevision: revision };
    });
  }

  reorder(principal: VerifiedPrincipal, input: SavedFilterOrder, key: string) {
    if (new Set(input.pinned).size !== input.pinned.length) throw new ControlInvalid('Pinned filters repeat');
    return this.command(principal, input.actingSubject, key, { kind: 'order', input }, async (client, owner, current) => {
      if (current !== input.expectedRevision) throw new ControlStale('Saved Filters changed');
      const pinned = (await client.query<{ id: string }>(`SELECT id FROM access.saved_filter
        WHERE principal_id = $1 AND pin_position IS NOT NULL`, [owner])).rows.map(row => row.id);
      if (pinned.length !== input.pinned.length || pinned.some(item => !input.pinned.includes(item))) {
        throw new ControlStale('Pinned filters changed');
      }
      await client.query(`UPDATE access.saved_filter AS f SET pin_position = o.ordinal - 1
        FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id, ordinal)
        WHERE f.principal_id = $1 AND f.id = o.id`, [owner, input.pinned]);
      return { action: 'reordered' as const, id: null, filterRevision: null };
    });
  }

  remove(principal: VerifiedPrincipal, id: string, input: SavedFilterDelete, key: string) {
    if (!uuid.test(id)) throw new ControlInvalid('Invalid Saved Filter');
    return this.command(principal, input.actingSubject, key, { kind: 'delete', id, input }, async (client, owner) => {
      const row = await this.locked(client, owner, id, input.expectedRevision);
      if (row.concept) throw new SavedFilterFollowed('Unfollow the Concept to remove its filter');
      if (row.pin_position !== null) await this.unpin(client, owner, id, row.pin_position);
      await client.query('DELETE FROM access.saved_filter WHERE principal_id = $1 AND id = $2', [owner, id]);
      await client.query(`UPDATE access.saved_filter_inventory SET named_count = named_count - 1
        WHERE principal_id = $1`, [owner]);
      return { action: 'deleted' as const, id, filterRevision: null };
    });
  }

  private async locked(client: PoolClient, owner: string, id: string, expected: string) {
    const row = (await client.query<SavedFilterRow>(`SELECT ${columns} FROM access.saved_filter
      WHERE principal_id = $1 AND id = $2 FOR UPDATE`, [owner, id])).rows[0];
    if (!row) throw new SavedFilterMissing('Saved Filter is unavailable');
    if (row.revision !== expected) throw new ControlStale('Saved Filter changed; refresh it');
    return row;
  }

  /** The next tab position, or a refusal when all eight are taken. */
  private async freeTab(client: PoolClient, owner: string) {
    const pinned = Number((await client.query<{ count: string }>(`SELECT count(*)::text AS count
      FROM access.saved_filter WHERE principal_id = $1 AND pin_position IS NOT NULL`, [owner])).rows[0]!.count);
    if (pinned >= SAVED_FILTER_COST.pinned) throw new SavedFilterTabsFull('Home already has eight pinned tabs');
    return pinned;
  }

  private async unpin(client: PoolClient, owner: string, id: string, position: number) {
    await client.query('UPDATE access.saved_filter SET pin_position = NULL WHERE principal_id = $1 AND id = $2',
      [owner, id]);
    await client.query(`UPDATE access.saved_filter SET pin_position = pin_position - 1
      WHERE principal_id = $1 AND pin_position > $2`, [owner, position]);
  }

  /** One receipt-guarded transaction under the reader's inventory lock. */
  private command(principal: VerifiedPrincipal, agent: string, key: string, command: Command,
    apply: (client: PoolClient, owner: string, revision: string) => Promise<Omit<SavedFilterReceipt,
      'profile' | 'revision' | 'replayed'>>): Promise<SavedFilterReceipt> {
    commandKey(key);
    if (!agentPattern.test(agent)) throw new ControlInvalid('Invalid person Agent');
    return controlTransaction(this.pool, async client => {
      const owner = await followPrincipal(client, principal, agent);
      await client.query(`INSERT INTO access.saved_filter_inventory (principal_id, revision) VALUES ($1,$2)
        ON CONFLICT (principal_id) DO NOTHING`, [owner, randomUUID()]);
      const inventory = (await client.query<{ revision: string }>(
        'SELECT revision FROM access.saved_filter_inventory WHERE principal_id = $1 FOR UPDATE', [owner])).rows[0]!;
      const intent = digest(command);
      const receipt = (await client.query<{ request_digest: string; result: SavedFilterReceipt }>(
        'SELECT request_digest, result FROM access.saved_filter_receipt WHERE principal_id = $1 AND idempotency_key = $2',
        [owner, key])).rows[0];
      if (receipt) {
        if (receipt.request_digest !== intent) throw new ControlConflict('Idempotency key has another Saved Filter intent');
        return { ...receipt.result, replayed: true };
      }
      const applied = await apply(client, owner, inventory.revision);
      const revision = randomUUID();
      await client.query('UPDATE access.saved_filter_inventory SET revision = $2 WHERE principal_id = $1',
        [owner, revision]);
      const result: SavedFilterReceipt = { profile: 'saved-filter-receipt-v1', ...applied, revision, replayed: false };
      await client.query(`INSERT INTO access.saved_filter_receipt (principal_id, idempotency_key, request_digest, result)
        VALUES ($1,$2,$3,$4)`, [owner, key, intent, result]);
      return result;
    });
  }
}
