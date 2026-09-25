import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ContentConflict, ContentUnavailable, type ContentPosition } from './core.ts';

export interface ContentCommentInput {
  revisionId: string;
  resourceId: string;
  author: string;
  exact: string;
  body: string;
}

export interface ContentCommentCommand extends ContentCommentInput {
  admissionId: string;
  authorityEpoch: string;
  scope: string;
  requestDigest: string;
}

export interface ContentComment {
  comment: string;
  author: string;
  resourceId: string;
  variantId: string;
  revisionId: string;
  byteDigest: string;
  body: string;
  target: {
    type: 'SpecificResource';
    source: string;
    selector: { type: 'TextQuoteSelector'; exact: string; prefix: string; suffix: string };
  };
  sourcePosition: ContentPosition;
  replayed: boolean;
}

export class ContentCommentInvalid extends Error {}
export class ContentCommentMissing extends Error {}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const work = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/i;
const sha = /^[0-9a-f]{64}$/;

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function contentCommentIntentDigest(input: ContentCommentInput): string {
  return hash(JSON.stringify({ family: 'content-comment-v1', revisionId: input.revisionId,
    resourceId: input.resourceId, author: input.author, exact: input.exact, body: input.body }));
}

function validate(input: ContentCommentInput): void {
  if (!uuid.test(input.revisionId) || !work.test(input.resourceId) || !work.test(input.author)
    || !input.exact || input.exact.length > 4096 || input.exact.includes('\n')
    || !input.body || input.body.length > 8192
    || Buffer.from(input.exact, 'utf8').toString('utf8') !== input.exact
    || Buffer.from(input.body, 'utf8').toString('utf8') !== input.body) {
    throw new ContentCommentInvalid('invalid exact comment');
  }
}

export function resolveParagraphSelector(text: string, exact: string): {
  type: 'TextQuoteSelector'; exact: string; prefix: string; suffix: string;
} {
  if (!exact || exact.includes('\n') || !text.split('\n').includes(exact)
    || text.indexOf(exact) !== text.lastIndexOf(exact)) {
    throw new ContentCommentInvalid('selector is not one unique paragraph of the exact revision');
  }
  const start = text.indexOf(exact);
  return { type: 'TextQuoteSelector', exact,
    prefix: text.slice(Math.max(0, start - 32), start),
    suffix: text.slice(start + exact.length, start + exact.length + 32) };
}

function asComment(row: Record<string, any>, replayed: boolean): ContentComment {
  return { comment: `https://rezics.com/id/${row.id}`, author: row.author,
    resourceId: row.resource_id, variantId: row.variant_id, revisionId: row.revision_id,
    byteDigest: row.byte_digest, body: row.comment_body,
    target: { type: 'SpecificResource', source: `urn:rezics:content:revision:${row.revision_id}`,
      selector: { type: 'TextQuoteSelector', exact: row.exact, prefix: row.prefix,
        suffix: row.suffix } },
    sourcePosition: { owner: 'content', dataEpoch: row.data_epoch,
      sequence: row.sequence }, replayed };
}

async function lock(client: PoolClient, admissionId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [`content-comment:${admissionId}`]);
}

/** Content owns the immutable annotation anchor and writes its receipt and outbox
 * in the same transaction. The exact revision bytes are checked under a row lock. */
export class ContentComments {
  constructor(private readonly pool: Pool) {}

  async create(command: ContentCommentCommand): Promise<ContentComment> {
    validate(command);
    if (!uuid.test(command.admissionId) || !/^(0|[1-9][0-9]*)$/.test(command.authorityEpoch)
      || command.scope !== `content:comment:${command.resourceId}`
      || !sha.test(command.requestDigest)
      || command.requestDigest !== contentCommentIntentDigest(command)) {
      throw new ContentConflict('comment admission does not bind the exact request');
    }
    const operationId = `content-comment:${command.admissionId}`;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lock(client, command.admissionId);
      const previous = await client.query(`SELECT c.*, r.byte_digest,
        c.body AS comment_body, receipt.sequence::text AS sequence
        , receipt.action, receipt.request_digest AS receipt_digest
        FROM content.receipt receipt LEFT JOIN content.comment c ON c.operation_id = receipt.operation_id
        LEFT JOIN content.revision r ON r.id = c.revision_id
        WHERE receipt.operation_id = $1`, [operationId]);
      if (previous.rowCount) {
        const row = previous.rows[0];
        if (row.receipt_digest !== command.requestDigest || row.action !== 'comment.create') {
          throw new ContentConflict('comment operation key reused');
        }
        if (!row.id) throw new ContentCommentMissing('comment admission was fenced');
        await client.query('COMMIT');
        return asComment(row, true);
      }
      const source = await client.query(`SELECT r.id, r.variant_id, r.byte_digest,
        r.byte_length, r.serialized_bytes, r.body, r.availability, v.resource_id
        FROM content.revision r JOIN content.variant v ON v.id = r.variant_id
        WHERE r.id = $1 FOR SHARE OF r`, [command.revisionId]);
      const row = source.rows[0];
      if (!row || row.resource_id !== command.resourceId) {
        throw new ContentCommentMissing('exact comment source is unavailable');
      }
      const bytes = row.serialized_bytes as Buffer | null;
      if (row.availability !== 'available' || !bytes || bytes.length !== row.byte_length
        || hash(bytes) !== row.byte_digest) {
        throw new ContentUnavailable('exact comment source bytes are unavailable');
      }
      let parsed: unknown;
      try { parsed = JSON.parse(bytes.toString('utf8')); }
      catch { throw new ContentUnavailable('exact comment source bytes are corrupt'); }
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object'
        || stable(parsed) !== stable(row.body)) {
        throw new ContentUnavailable('exact comment source body differs');
      }
      const text = (parsed as { body?: unknown }).body;
      if (typeof text !== 'string') throw new ContentCommentInvalid('source has no text body');
      const { prefix, suffix } = resolveParagraphSelector(text, command.exact);
      const owner = await client.query(`UPDATE content.owner_control SET sequence = sequence + 1
        WHERE singleton RETURNING data_epoch, sequence::text AS sequence`);
      if (owner.rowCount !== 1) throw new ContentUnavailable('Content owner position unavailable');
      const { data_epoch, sequence } = owner.rows[0];
      const id = randomUUID();
      await client.query(`INSERT INTO content.receipt
        (operation_id, request_digest, action, outcome, variant_id, revision_id,
          data_epoch, sequence) VALUES ($1,$2,'comment.create','succeeded',$3,$4,$5,$6)`,
      [operationId, command.requestDigest, row.variant_id, command.revisionId,
        data_epoch, sequence]);
      await client.query(`INSERT INTO content.comment
        (id, operation_id, request_digest, revision_id, resource_id, variant_id,
          author, exact, prefix, suffix, body, data_epoch, sequence)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, operationId, command.requestDigest, command.revisionId, command.resourceId,
        row.variant_id, command.author, command.exact, prefix, suffix, command.body,
        data_epoch, sequence]);
      await client.query(`INSERT INTO content.outbox
        (id, data_epoch, sequence, operation_id, event_type, recipe, revision_id, payload)
        VALUES ($1,$2,$3,$4,'content.comment.created','content-body-v1',$5,$6::jsonb)`,
      [randomUUID(), data_epoch, sequence, operationId, command.revisionId,
        JSON.stringify({ comment: id, revisionId: command.revisionId })]);
      await client.query('COMMIT');
      return asComment({ id, author: command.author, resource_id: command.resourceId,
        variant_id: row.variant_id, revision_id: command.revisionId,
        byte_digest: row.byte_digest, comment_body: command.body, exact: command.exact,
        prefix, suffix, data_epoch, sequence }, false);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async read(commentId: string): Promise<ContentComment | null> {
    if (!uuid.test(commentId)) throw new ContentCommentInvalid('invalid comment id');
    const result = await this.pool.query(`SELECT c.*, r.byte_digest,
      c.body AS comment_body, c.sequence::text AS sequence
      FROM content.comment c JOIN content.revision r ON r.id = c.revision_id
      WHERE c.id = $1`, [commentId]);
    return result.rowCount ? asComment(result.rows[0], false) : null;
  }

  async readReceipt(admissionId: string): Promise<{ outcome: 'succeeded' | 'cancelled';
    position: ContentPosition } | null> {
    if (!uuid.test(admissionId)) throw new ContentCommentInvalid('invalid admission id');
    const result = await this.pool.query(`SELECT outcome, data_epoch,
      sequence::text AS sequence FROM content.receipt
      WHERE operation_id = $1 AND action = 'comment.create'`,
    [`content-comment:${admissionId}`]);
    const row = result.rows[0];
    return row ? { outcome: row.outcome === 'succeeded' ? 'succeeded' : 'cancelled',
      position: { owner: 'content', dataEpoch: row.data_epoch, sequence: row.sequence } } : null;
  }

  async cancel(admissionId: string, requestDigest: string): Promise<{
    outcome: 'succeeded' | 'cancelled'; position: ContentPosition }> {
    if (!uuid.test(admissionId) || !sha.test(requestDigest)) {
      throw new ContentCommentInvalid('invalid admission proof');
    }
    const operationId = `content-comment:${admissionId}`;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lock(client, admissionId);
      const previous = await client.query(`SELECT request_digest, action, outcome, data_epoch,
        sequence::text AS sequence FROM content.receipt WHERE operation_id = $1`, [operationId]);
      if (previous.rowCount) {
        const row = previous.rows[0];
        if (row.request_digest !== requestDigest || row.action !== 'comment.create') {
          throw new ContentConflict('comment operation key reused');
        }
        await client.query('COMMIT');
        return { outcome: row.outcome === 'succeeded' ? 'succeeded' : 'cancelled',
          position: { owner: 'content', dataEpoch: row.data_epoch, sequence: row.sequence } };
      }
      const owner = await client.query(`UPDATE content.owner_control SET sequence = sequence + 1
        WHERE singleton RETURNING data_epoch, sequence::text AS sequence`);
      if (owner.rowCount !== 1) throw new ContentUnavailable('Content owner position unavailable');
      const { data_epoch, sequence } = owner.rows[0];
      await client.query(`INSERT INTO content.receipt
        (operation_id, request_digest, action, outcome, data_epoch, sequence, reason)
        VALUES ($1,$2,'comment.create','rejected',$3,$4,'admission-fenced')`,
      [operationId, requestDigest, data_epoch, sequence]);
      await client.query(`INSERT INTO content.outbox
        (id, data_epoch, sequence, operation_id, event_type, recipe, payload)
        VALUES ($1,$2,$3,$4,'content.comment.cancelled','content-body-v1',$5::jsonb)`,
      [randomUUID(), data_epoch, sequence, operationId,
        JSON.stringify({ admissionId, reason: 'admission-fenced' })]);
      await client.query('COMMIT');
      return { outcome: 'cancelled', position: { owner: 'content', dataEpoch: data_epoch, sequence } };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
}
