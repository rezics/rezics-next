import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { type ContentCommentQuoteTarget, type ContentCommentTarget }
  from '../../../packages/model/src/locator.ts';
import type { ContentPosition } from './core.ts';
import { ContentConflict, ContentUnavailable } from './errors.ts';
import { appendContentEvent, contentEventPosition } from './event-sequencer.ts';
import { retainedDocumentBody } from './document-body.ts';
import { checkDocument, documentParagraphs } from '@rezics/document';

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
  type: 'Annotation';
  motivation: 'commenting';
  comment: string;
  author: string;
  resourceId: string;
  variantId: string;
  revisionId: string;
  byteDigest: string;
  body: string;
  target: ContentCommentTarget;
  sourcePosition: ContentPosition;
  replayed: boolean;
}

export class ContentCommentInvalid extends Error {}
export class ContentCommentMissing extends Error {}
export class ContentCommentCursorStale extends Error {}

export interface ContentCommentPage {
  revisionId: string;
  comments: ContentComment[];
  sourcePosition: ContentPosition;
  next: string | null;
}

interface CommentCursor {
  version: 1;
  revisionId: string;
  dataEpoch: string;
  throughOrder: string;
  afterOrder: string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const work = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/i;
const sha = /^[0-9a-f]{64}$/;
const decimal = /^(0|[1-9][0-9]*)$/;
const maxOrder = 9_223_372_036_854_775_807n;

function decodeCursor(value: string, revisionId: string): CommentCursor {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) {
    throw new ContentCommentInvalid('invalid comment continuation');
  }
  let parsed: unknown;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error('noncanonical continuation');
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ContentCommentInvalid('invalid comment continuation');
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new ContentCommentInvalid('invalid comment continuation');
  }
  const cursor = parsed as Partial<CommentCursor>;
  if (
    Object.keys(cursor).length !== 5 ||
    cursor.version !== 1 ||
    cursor.revisionId !== revisionId ||
    typeof cursor.dataEpoch !== 'string' ||
    !uuid.test(cursor.dataEpoch) ||
    typeof cursor.throughOrder !== 'string' ||
    typeof cursor.afterOrder !== 'string' ||
    !decimal.test(cursor.throughOrder) ||
    !decimal.test(cursor.afterOrder) ||
    BigInt(cursor.throughOrder) > maxOrder ||
    BigInt(cursor.afterOrder) >= BigInt(cursor.throughOrder)
  ) {
    throw new ContentCommentInvalid('invalid comment continuation');
  }
  return cursor as CommentCursor;
}

function encodeCursor(cursor: CommentCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function contentCommentIntentDigest(input: ContentCommentInput): string {
  return hash(
    JSON.stringify({
      family: 'content-comment-v1',
      revisionId: input.revisionId,
      resourceId: input.resourceId,
      author: input.author,
      exact: input.exact,
      body: input.body,
    }),
  );
}

function validate(input: ContentCommentInput): void {
  if (
    !uuid.test(input.revisionId) ||
    !work.test(input.resourceId) ||
    !work.test(input.author) ||
    !input.exact ||
    input.exact.length > 4096 ||
    input.exact.includes('\n') ||
    !input.body ||
    input.body.length > 8192 ||
    Buffer.from(input.exact, 'utf8').toString('utf8') !== input.exact ||
    Buffer.from(input.body, 'utf8').toString('utf8') !== input.body
  ) {
    throw new ContentCommentInvalid('invalid exact comment');
  }
}

export function resolveParagraphSelector(
  text: string,
  exact: string,
  document?: unknown,
): ContentCommentQuoteTarget['selector'] {
  if (document !== undefined && !checkDocument(document))
    throw new ContentCommentInvalid('invalid document source');
  const paragraphs = checkDocument(document)
    ? documentParagraphs(document).map((unit) => unit.text)
    : text.split('\n');
  if (
    !exact ||
    (document === undefined && exact.includes('\n')) ||
    !paragraphs.includes(exact) ||
    text.indexOf(exact) !== text.lastIndexOf(exact)
  ) {
    throw new ContentCommentInvalid('selector is not one unique paragraph of the exact revision');
  }
  const start = text.indexOf(exact);
  if (document !== undefined)
    return {
      type: 'TextQuoteSelector',
      exact,
      prefix: Array.from(text.slice(0, start)).slice(-32).join(''),
      suffix: Array.from(text.slice(start + exact.length))
        .slice(0, 32)
        .join(''),
    };
  return {
    type: 'TextQuoteSelector',
    exact,
    prefix: text.slice(Math.max(0, start - 32), start),
    suffix: text.slice(start + exact.length, start + exact.length + 32),
  };
}

/** Indexed existence of a remaining quote, at most one probe per revision. */
export async function revisionsWithOpenCommentSource(pool: Pool | PoolClient,
  revisionIds: readonly string[]): Promise<string[]> {
  if (revisionIds.length > 64) throw new ContentCommentInvalid('comment source check is too large');
  if (!revisionIds.length) return [];
  const rows = (await pool.query<{ revision_id: string }>(`SELECT wanted.id::text AS revision_id
    FROM unnest($1::uuid[]) AS wanted(id)
    WHERE EXISTS (
      SELECT 1 FROM content.comment c
      WHERE c.revision_id = wanted.id
        AND (c.exact IS NOT NULL OR c.prefix IS NOT NULL OR c.suffix IS NOT NULL)
    )
    ORDER BY wanted.id`, [revisionIds])).rows;
  return rows.map(row => row.revision_id);
}

/** A cleared source anchor has no selector. Callers must not rebuild the quote. */
export function commentTargetHasSource(
  target: ContentCommentTarget,
): target is ContentCommentQuoteTarget {
  return 'selector' in target;
}

function commentTarget(row: Record<string, any>): ContentCommentTarget {
  const source = `urn:rezics:content:revision:${row.revision_id}`;
  const cleared = row.exact == null && row.prefix == null && row.suffix == null;
  if (cleared) return { type: 'SpecificResource', source };
  if (row.exact == null || row.prefix == null || row.suffix == null) {
    throw new ContentCommentInvalid('comment source selector is partial');
  }
  return {
    type: 'SpecificResource',
    source,
    selector: { type: 'TextQuoteSelector', exact: row.exact, prefix: row.prefix, suffix: row.suffix },
  };
}

function asComment(row: Record<string, any>, replayed: boolean): ContentComment {
  return {
    type: 'Annotation',
    motivation: 'commenting',
    comment: `https://rezics.com/id/${row.id}`,
    author: row.author,
    resourceId: row.resource_id,
    variantId: row.variant_id,
    revisionId: row.revision_id,
    byteDigest: row.byte_digest,
    body: row.comment_body,
    target: commentTarget(row),
    sourcePosition: { owner: 'content', dataEpoch: row.data_epoch, sequence: row.sequence },
    replayed,
  };
}

async function lock(client: PoolClient, admissionId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `content-comment:${admissionId}`,
  ]);
}

async function begin(client: PoolClient): Promise<void> {
  await client.query("BEGIN; SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '5s'");
}

/** A comment is listed and read once its receipt holds a position. */
const POSITIONED = `SELECT c.*, r.byte_digest, c.body AS comment_body,
  receipt.data_epoch, receipt.sequence::text AS sequence
  FROM content.comment c JOIN content.revision r ON r.id = c.revision_id
  JOIN content.receipt receipt ON receipt.operation_id = c.operation_id AND receipt.sequence IS NOT NULL`;

/** Content owns the immutable annotation anchor and writes its receipt and outbox
 * in the same transaction. The exact revision bytes are checked under a row lock. */
export class ContentComments {
  constructor(private readonly pool: Pool) {}

  async create(command: ContentCommentCommand): Promise<ContentComment> {
    validate(command);
    if (
      !uuid.test(command.admissionId) ||
      !/^(0|[1-9][0-9]*)$/.test(command.authorityEpoch) ||
      command.scope !== `content:comment:${command.resourceId}` ||
      !sha.test(command.requestDigest) ||
      command.requestDigest !== contentCommentIntentDigest(command)
    ) {
      throw new ContentConflict('comment admission does not bind the exact request');
    }
    const operationId = `content-comment:${command.admissionId}`;
    const client = await this.pool.connect();
    let saved: { row: Record<string, any>; replayed: boolean };
    try {
      await begin(client);
      await lock(client, command.admissionId);
      const previous = await client.query(
        `SELECT c.*, r.byte_digest,
        c.body AS comment_body, receipt.action, receipt.request_digest AS receipt_digest
        FROM content.receipt receipt LEFT JOIN content.comment c ON c.operation_id = receipt.operation_id
        LEFT JOIN content.revision r ON r.id = c.revision_id
        WHERE receipt.operation_id = $1`,
        [operationId],
      );
      if (previous.rowCount) {
        const row = previous.rows[0];
        if (row.receipt_digest !== command.requestDigest || row.action !== 'comment.create') {
          throw new ContentConflict('comment operation key reused');
        }
        if (!row.id) throw new ContentCommentMissing('comment admission was fenced');
        await client.query('COMMIT');
        saved = { row, replayed: true };
      } else saved = { row: await this.record(client, command, operationId), replayed: false };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const position = await contentEventPosition(this.pool, operationId);
    return asComment({ ...saved.row, data_epoch: position.dataEpoch, sequence: position.sequence },
      saved.replayed);
  }

  /** The new comment's row; commits the caller's transaction. */
  private async record(client: PoolClient, command: ContentCommentCommand,
    operationId: string): Promise<Record<string, any>> {
    const source = await client.query(
      `SELECT r.id, r.variant_id, r.byte_digest,
      r.byte_length, r.serialized_bytes, r.body, r.availability, v.resource_id
      FROM content.revision r JOIN content.variant v ON v.id = r.variant_id
      WHERE r.id = $1 FOR SHARE OF r`,
      [command.revisionId],
    );
    const row = source.rows[0];
    if (!row || row.resource_id !== command.resourceId) {
      throw new ContentCommentMissing('exact comment source is unavailable');
    }
    const bytes = row.serialized_bytes as Buffer | null;
    if (
      row.availability !== 'available' ||
      !bytes ||
      bytes.length !== row.byte_length ||
      hash(bytes) !== row.byte_digest
    ) {
      throw new ContentUnavailable('exact comment source bytes are unavailable');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new ContentUnavailable('exact comment source bytes are corrupt');
    }
    if (
      !parsed ||
      Array.isArray(parsed) ||
      typeof parsed !== 'object' ||
      stable(parsed) !== stable(row.body)
    ) {
      throw new ContentUnavailable('exact comment source body differs');
    }
    let authoredSource: ReturnType<typeof retainedDocumentBody>;
    try {
      authoredSource = retainedDocumentBody(parsed as Record<string, unknown>);
    } catch {
      throw new ContentCommentInvalid('source text or document projection is invalid');
    }
    const { prefix, suffix } = resolveParagraphSelector(
      authoredSource.body,
      command.exact,
      authoredSource.document,
    );
    // Comments on one revision commit in list order, so the numbered ones are
    // always a prefix of it and a listing's frozen cut never gains a member.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `content-comment-order:${command.revisionId}`,
    ]);
    const id = randomUUID();
    await appendContentEvent(client, {
      operationId,
      requestDigest: command.requestDigest,
      action: 'comment.create',
      outcome: 'succeeded',
      variantId: row.variant_id,
      revisionId: command.revisionId,
      eventType: 'content.comment.created',
      recipe: 'content-body-v1',
      payload: { comment: id, revisionId: command.revisionId },
    });
    await client.query(
      `INSERT INTO content.comment
      (id, operation_id, request_digest, revision_id, resource_id, variant_id,
        author, exact, prefix, suffix, body)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id,
        operationId,
        command.requestDigest,
        command.revisionId,
        command.resourceId,
        row.variant_id,
        command.author,
        command.exact,
        prefix,
        suffix,
        command.body,
      ],
    );
    await client.query('COMMIT');
    return {
      id,
      author: command.author,
      resource_id: command.resourceId,
      variant_id: row.variant_id,
      revision_id: command.revisionId,
      byte_digest: row.byte_digest,
      comment_body: command.body,
      exact: command.exact,
      prefix,
      suffix,
    };
  }

  /** One revision's open-source probe. An empty page is not proof the quotes are gone. */
  hasOpenCommentSource(revisionId: string): Promise<boolean> {
    return revisionsWithOpenCommentSource(this.pool, [revisionId]).then(open => open.length > 0);
  }

  async read(commentId: string): Promise<ContentComment | null> {
    if (!uuid.test(commentId)) throw new ContentCommentInvalid('invalid comment id');
    const result = await this.pool.query(`${POSITIONED} WHERE c.id = $1`, [commentId]);
    return result.rowCount ? asComment(result.rows[0], false) : null;
  }

  /** A stable prefix of one revision's numbered comments. Create serializes one
   * revision's comments, so its numbered comments are a list_order prefix. The
   * cursor grants no authority; callers must check current disclosure on every page. */
  async list(
    revisionId: string,
    pageSize = 50,
    continuation?: string,
  ): Promise<ContentCommentPage> {
    if (
      !uuid.test(revisionId) ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    ) {
      throw new ContentCommentInvalid('invalid comment page request');
    }
    const prior = continuation ? decodeCursor(continuation, revisionId) : null;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const owner = await client.query(`SELECT data_epoch, sequence::text AS sequence
        FROM content.owner_control WHERE singleton`);
      if (owner.rowCount !== 1) throw new ContentUnavailable('Content owner position unavailable');
      const position: ContentPosition = {
        owner: 'content',
        dataEpoch: owner.rows[0].data_epoch,
        sequence: owner.rows[0].sequence,
      };
      if (prior && prior.dataEpoch !== position.dataEpoch) {
        throw new ContentCommentCursorStale('Content owner epoch changed');
      }
      const maximum = await client.query<{ last: string }>(
        `SELECT c.list_order::text AS last FROM content.comment c
        JOIN content.receipt receipt ON receipt.operation_id = c.operation_id
          AND receipt.sequence IS NOT NULL
        WHERE c.revision_id = $1 ORDER BY c.list_order DESC LIMIT 1`,
        [revisionId],
      );
      const lastOrder = maximum.rows[0]?.last ?? '0';
      if (prior && BigInt(prior.throughOrder) > BigInt(lastOrder)) {
        throw new ContentCommentCursorStale(
          'comment continuation is beyond the retained owner cut',
        );
      }
      const throughOrder = prior?.throughOrder ?? lastOrder;
      const afterOrder = prior?.afterOrder ?? '0';
      const result = await client.query(
        `${POSITIONED.replace('SELECT c.*,', 'SELECT c.*, c.list_order::text AS list_order,')}
        WHERE c.revision_id = $1 AND c.list_order > $2::bigint
          AND c.list_order <= $3::bigint
        ORDER BY c.list_order LIMIT $4`,
        [revisionId, afterOrder, throughOrder, pageSize + 1],
      );
      await client.query('COMMIT');
      const rows = result.rows.slice(0, pageSize);
      const next =
        result.rows.length > pageSize
          ? encodeCursor({
              version: 1,
              revisionId,
              dataEpoch: position.dataEpoch,
              throughOrder,
              afterOrder: rows.at(-1)!.list_order,
            })
          : null;
      return {
        revisionId,
        comments: rows.map((row) => asComment(row, false)),
        sourcePosition: position,
        next,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async readReceipt(
    admissionId: string,
  ): Promise<{ outcome: 'succeeded' | 'cancelled'; position: ContentPosition } | null> {
    if (!uuid.test(admissionId)) throw new ContentCommentInvalid('invalid admission id');
    const result = await this.pool.query(
      `SELECT outcome, data_epoch,
      sequence::text AS sequence FROM content.receipt
      WHERE operation_id = $1 AND action = 'comment.create'`,
      [`content-comment:${admissionId}`],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      outcome: row.outcome === 'succeeded' ? 'succeeded' : 'cancelled',
      position: row.sequence
        ? { owner: 'content', dataEpoch: row.data_epoch, sequence: row.sequence }
        : await contentEventPosition(this.pool, `content-comment:${admissionId}`),
    };
  }

  async cancel(
    admissionId: string,
    requestDigest: string,
  ): Promise<{
    outcome: 'succeeded' | 'cancelled';
    position: ContentPosition;
  }> {
    if (!uuid.test(admissionId) || !sha.test(requestDigest)) {
      throw new ContentCommentInvalid('invalid admission proof');
    }
    const operationId = `content-comment:${admissionId}`;
    const client = await this.pool.connect();
    let outcome: 'succeeded' | 'cancelled';
    try {
      await begin(client);
      await lock(client, admissionId);
      const previous = await client.query(
        `SELECT request_digest, action, outcome FROM content.receipt WHERE operation_id = $1`,
        [operationId],
      );
      if (previous.rowCount) {
        const row = previous.rows[0];
        if (row.request_digest !== requestDigest || row.action !== 'comment.create') {
          throw new ContentConflict('comment operation key reused');
        }
        outcome = row.outcome === 'succeeded' ? 'succeeded' : 'cancelled';
      } else {
        await appendContentEvent(client, {
          operationId,
          requestDigest,
          action: 'comment.create',
          outcome: 'rejected',
          reason: 'admission-fenced',
          eventType: 'content.comment.cancelled',
          recipe: 'content-body-v1',
          payload: { admissionId, reason: 'admission-fenced' },
        });
        outcome = 'cancelled';
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return { outcome, position: await contentEventPosition(this.pool, operationId) };
  }
}
