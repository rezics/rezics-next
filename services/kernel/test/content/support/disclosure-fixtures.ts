import { createHash } from 'node:crypto';
import { documentText, fromPlainText, serializeDocument, type DocumentSnapshot } from '@rezics/document';
import type { Pool } from 'pg';
import { createTurnstileVerifier, type TurnstileVerifier } from '../../../src/content/turnstile.ts';
import { newId } from '../../../src/route/route.ts';
import type { Revision } from '../../../../../specs/content-disclosure-driver.ts';

export const AUDIENCE = 'https://content.test';
export const PROJECTION_CONSUMER = 'disclosure_projection';
export const BOARD_TITLE = 'Disclosure topic';
export const TURNSTILE_HOSTNAME = 'content.test';
export const TURNSTILE_ACTION = 'report';

/** Trusted operational budgets. Verification and authorization stay on the product path. */
export const HIGH_RATE_OVERRIDES = JSON.stringify(
  Object.fromEntries(
    ['anonymous', 'new-account', 'member', 'trusted', 'service'].map((principal) => [
      principal,
      {
        write: { maximum: 1_000_000, seconds: 60 },
        report: { maximum: 1_000_000, seconds: 60 },
      },
    ]),
  ),
);

const EFFECT_KIND = {
  'com.rezics.content.moderation.takedown.v1': 'takedown',
  'com.rezics.content.moderation.erasure.v1': 'erasure',
  'com.rezics.content.report.created.v1': 'report',
} as const;

export const EFFECT_TYPES = Object.keys(EFFECT_KIND);

export function effectKind(type: string): 'takedown' | 'erasure' | 'report' | undefined {
  return EFFECT_KIND[type as keyof typeof EFFECT_KIND];
}

export function storedVisibility(value: string): 'public' | 'protected' | 'taken_down' {
  if (value === 'published') return 'public';
  if (value === 'protected' || value === 'taken_down') return value;
  throw new Error(`Unexpected stored visibility ${value}`);
}

/** Recover text from the actual document. A missing digest stays empty so an erased HTTP null is not invented. */
export function revisionFromView(value: unknown): Revision {
  if (!value || typeof value !== 'object') throw new Error('Content view is missing a revision');
  const view = value as Record<string, unknown>;
  if (typeof view.revisionId !== 'string') throw new Error('Content view is missing revisionId');
  if (view.availability !== 'available' && view.availability !== 'erased')
    throw new Error('Content view is missing availability');
  if (view.body !== null && (typeof view.body !== 'object' || view.body === null))
    throw new Error('Content view body is not a document');
  if (typeof view.sha256 !== 'string' && view.sha256 !== null) throw new Error('Content view is missing sha256');
  return {
    id: view.revisionId,
    hash: typeof view.sha256 === 'string' ? view.sha256 : '',
    body: view.body === null ? null : documentText(view.body as DocumentSnapshot),
    availability: view.availability,
  };
}

export function documentBytes(text: string): Uint8Array {
  return new TextEncoder().encode(serializeDocument(fromPlainText(text)));
}

export function hexDigest(bytes: Uint8Array): Buffer {
  return createHash('sha256').update(bytes).digest();
}

export function textFromBytea(value: unknown): string | null {
  if (value === null) return null;
  const bytes = Buffer.isBuffer(value) ? value : value instanceof Uint8Array ? Buffer.from(value) : null;
  if (!bytes) throw new Error('Revision body is not stored bytea');
  return documentText(JSON.parse(bytes.toString('utf8')) as DocumentSnapshot);
}

export function hexFromBytea(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  throw new Error('Revision digest is not stored bytea');
}

/** Opaque one-use provider tokens. Production siteverify still checks success, hostname and action. */
export function createDisclosureTurnstile(): { verifier: TurnstileVerifier; mint(): string } {
  const issued = new Set<string>();
  const verifier = createTurnstileVerifier({
    secret: 'disclosure-provider-secret',
    hostname: TURNSTILE_HOSTNAME,
    action: TURNSTILE_ACTION,
    fetch: async (_url, init) => {
      const token = new URLSearchParams(String(init?.body)).get('response') ?? '';
      return Response.json({
        success: issued.delete(token),
        hostname: TURNSTILE_HOSTNAME,
        action: TURNSTILE_ACTION,
      });
    },
  });
  return {
    verifier,
    mint() {
      const token = crypto.randomUUID();
      issued.add(token);
      return token;
    },
  };
}

export async function seedDisclosureDistractors(
  admin: Pool,
  route: number,
  authorId: string,
  distractorBoardId: string,
  count: number,
): Promise<void> {
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('Growth seed count is not valid');
  if (count === 0) return;
  const threadIds: string[] = [];
  const postIds: string[] = [];
  const revisionIds: string[] = [];
  const mediaIds: string[] = [];
  const containerIds: string[] = [];
  const transactionIds: string[] = [];
  const reservationIds: string[] = [];
  for (let index = 0; index < count; index++) {
    threadIds.push(newId(route));
    postIds.push(newId(route));
    revisionIds.push(newId(route));
    mediaIds.push(newId(route));
    containerIds.push(newId(route));
    transactionIds.push(crypto.randomUUID());
    reservationIds.push(`disclosure-growth-${crypto.randomUUID()}`);
  }
  const body = Buffer.from('unrelated disclosure neighbour');
  const digest = hexDigest(body);
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO content.thread
         (route, thread_id, author_account_id, board_id, title, visibility, security_revision,
          recorded_transaction_id, first_post_id, availability)
       SELECT $1, thread_id, $2, $3, 'Unrelated disclosure', 'published', 1, transaction_id, post_id, 'available'
       FROM unnest($4::uuid[], $5::uuid[], $6::uuid[]) AS row(thread_id, post_id, transaction_id)`,
      [route, authorId, distractorBoardId, threadIds, postIds, transactionIds],
    );
    await client.query(
      `INSERT INTO content.post
         (route, thread_id, post_id, reply_to_post_id, author_account_id, head_revision_id, visibility,
          security_revision, recorded_transaction_id, availability)
       SELECT $1, thread_id, post_id, NULL, $2, revision_id, 'published', 1, transaction_id, 'available'
       FROM unnest($3::uuid[], $4::uuid[], $5::uuid[], $6::uuid[])
         AS row(thread_id, post_id, revision_id, transaction_id)`,
      [route, authorId, threadIds, postIds, revisionIds, transactionIds],
    );
    await client.query(
      `INSERT INTO content.revision
         (route, thread_id, post_id, revision_id, body, body_sha256, search_text, licence, subject_ids,
          board_id, availability, recorded_transaction_id, media_ids)
       SELECT $1, thread_id, post_id, revision_id, $2, $3, 'unrelated', 'MIT', '{}'::uuid[], $4, 'available',
              transaction_id, '{}'::uuid[]
       FROM unnest($5::uuid[], $6::uuid[], $7::uuid[], $8::uuid[])
         AS row(thread_id, post_id, revision_id, transaction_id)`,
      [route, body, digest, distractorBoardId, threadIds, postIds, revisionIds, transactionIds],
    );
    await client.query(
      `INSERT INTO content.board_thread
         (route, board_id, thread_id, created_at, source_epoch, source_position, source_revision_id)
       SELECT $1, $2, thread_id, transaction_timestamp(), 1, 1, revision_id
       FROM unnest($3::uuid[], $4::uuid[]) AS row(thread_id, revision_id)`,
      [route, distractorBoardId, threadIds, revisionIds],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  // Reserved media is same-partition volume only. A schema mismatch must not discard the content rows.
  const media = await admin.connect();
  try {
    await media.query('BEGIN');
    try {
      await media.query(
        `INSERT INTO content.media
           (route, media_id, container_id, uploader_id, reservation_request_id, purpose, media_type, byte_count,
            state, key, transaction_id)
         SELECT $1, media_id, container_id, $2, reservation_id, 'post-image', 'image/png', 1, 'reserved',
                'm/' || media_id::text || '/original', transaction_id
         FROM unnest($3::uuid[], $4::uuid[], $5::text[], $6::uuid[])
           AS row(media_id, container_id, reservation_id, transaction_id)`,
        [route, authorId, mediaIds, containerIds, reservationIds, transactionIds],
      );
      await media.query('COMMIT');
    } catch {
      await media.query('ROLLBACK');
    }
  } finally {
    media.release();
  }
  await admin.query(
    'ANALYZE content.board, content.board_thread, content.thread, content.post, content.revision, content.media',
  );
}
