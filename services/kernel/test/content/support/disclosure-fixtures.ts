import { createAuthConsentReader } from '../../../src/request/auth-consent.ts';
import { systemClock } from '../../../src/clock.ts';
import { R2Storage } from '../../../src/content/r2-storage.ts';
import { createContentWorkAccess } from '../../../src/content/register.ts';
import { contentEffects } from '../../../src/content/relays.ts';
import { createContentWork } from '../../../src/content/work.ts';
import { startWorker } from '../../../src/worker.ts';
import { createHash, randomUUID } from 'node:crypto';
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
/** Suite publishes and cursor ties use this command instant. Administrative rows open here. */
export const FIXTURE_T = '2026-01-01T00:00:00.000Z';

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
    hash: view.sha256,
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

export function hexFromBytea(value: unknown): string | null {
  if (value === null) return null;
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  throw new Error('Revision digest is not stored bytea');
}

/**
 * Setup only. Content roles do not hold access:grant, and thread:read is not a
 * platform-reach action, so the governance account cannot call the public grant
 * or role-revoke APIs until these rows exist. Role revocation checks every action
 * in the owner template, and moderation grants check the moderation actions.
 * The Access formula still decides every read. Valid from the suite clock.
 */
export async function seedGovernanceAuthority(
  admin: Pool,
  route: number,
  resourceId: string,
  accountId: string,
  actions: readonly string[],
): Promise<void> {
  if (actions.length === 0) return;
  await admin.query(
    `INSERT INTO access.resource_grant
       (route, resource_id, subject_kind, subject_id, subject_role, action, valid, transaction_id)
     SELECT $1, $2, 'identity', $3, '', candidate.action, tstzrange($4::timestamptz, NULL, '[)'), $5
     FROM unnest($6::text[]) AS candidate(action)
     WHERE NOT EXISTS (
       SELECT 1
       FROM access.resource_grant existing
       WHERE existing.route = $1
         AND existing.resource_id = $2
         AND existing.subject_kind = 'identity'
         AND existing.subject_id = $3
         AND existing.subject_role = ''
         AND existing.action = candidate.action
         AND existing.valid && tstzrange($4::timestamptz, NULL, '[)')
     )`,
    [route, resourceId, accountId, FIXTURE_T, randomUUID(), actions],
  );
}

/** An overriding resource denial. There is no public denial command; the formula reads this row. */
export async function seedResourceDenial(
  admin: Pool,
  route: number,
  resourceId: string,
  accountId: string,
  actions: readonly string[],
): Promise<void> {
  if (actions.length === 0) return;
  await admin.query(
    `INSERT INTO access.resource_denial
       (route, resource_id, subject_id, subject_role, action, reason, valid, transaction_id)
     SELECT $1, $2, $3, '', candidate.action, 'resource', tstzrange($4::timestamptz, NULL, '[)'), $5
     FROM unnest($6::text[]) AS candidate(action)
     WHERE NOT EXISTS (
       SELECT 1
       FROM access.resource_denial existing
       WHERE existing.route = $1
         AND existing.resource_id = $2
         AND existing.subject_id = $3
         AND existing.subject_role = ''
         AND existing.action = candidate.action
         AND existing.reason = 'resource'
         AND upper_inf(existing.valid)
     )`,
    [route, resourceId, accountId, FIXTURE_T, randomUUID(), actions],
  );
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
  const subjectIds: string[] = [];
  const transactionIds: string[] = [];
  const reservationIds: string[] = [];
  for (let index = 0; index < count; index++) {
    threadIds.push(newId(route));
    postIds.push(newId(route));
    revisionIds.push(newId(route));
    mediaIds.push(newId(route));
    subjectIds.push(newId(route));
    transactionIds.push(crypto.randomUUID());
    reservationIds.push(`disclosure-growth-${crypto.randomUUID()}`);
  }
  const body = Buffer.from(documentBytes('unrelated disclosure neighbour'));
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
    await client.query(
      `INSERT INTO semantic.subject (route, subject_id, type, recorded_transaction_id)
       SELECT $1, subject_id, 'schema:Book', transaction_id
       FROM unnest($2::uuid[], $3::uuid[]) AS row(subject_id, transaction_id)`,
      [route, subjectIds, transactionIds],
    );
    await client.query(
      `INSERT INTO content.media
         (route, media_id, container_id, uploader_id, reservation_request_id, purpose, media_type, byte_count,
          state, key, transaction_id)
       SELECT $1, media_id, thread_id, $2, reservation_id, 'post-image', 'image/png', 1, 'reserved',
              'm/' || media_id::text || '/original', transaction_id
       FROM unnest($3::uuid[], $4::uuid[], $5::text[], $6::uuid[])
         AS row(media_id, thread_id, reservation_id, transaction_id)`,
      [route, authorId, mediaIds, threadIds, reservationIds, transactionIds],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await admin.query(
    'ANALYZE content.board, content.board_thread, content.thread, content.post, content.revision, content.media, semantic.subject',
  );
}

async function runDisclosureWorker(): Promise<void> {
  const endpoint = process.env.CONTENT_TEST_STORAGE;
  if (!endpoint) throw new Error('Disclosure worker storage endpoint is missing');
  const storage = new R2Storage({
    endpoint,
    bucket: 'media-test',
    accessKeyId: 'fixture',
    secretAccessKey: 'fixture-secret',
    maxObjectBytes: 20 * 1024 * 1024,
    fetch,
  });
  const holdAccountUploadIndex = process.argv.includes('--hold-account-upload-index');
  let releaseAccountUploadIndex: (() => void) | undefined;
  const accountUploadIndexGate = holdAccountUploadIndex
    ? new Promise<void>((resolve) => {
        releaseAccountUploadIndex = resolve;
      })
    : Promise.resolve();
  const worker = await startWorker(
    {
      databaseUrl: process.env.DATABASE_URL ?? '',
      executorId: 'disclosure-test',
      poolSize: 5,
    },
    [
      {
        name: 'content',
        async register(context) {
          const testContext = {
            ...context,
            addEffects(effects: Parameters<typeof context.addEffects>[0]) {
              context.addEffects(
                effects.map((effect) =>
                  effect.name === 'content_account_upload_index' && holdAccountUploadIndex
                    ? {
                        ...effect,
                        async run(event) {
                          if (event.type === 'com.rezics.content.media.reserved.v1') {
                            console.log('account-upload-index-held');
                            await accountUploadIndexGate;
                          }
                          return effect.run(event);
                        },
                      }
                    : effect,
                ),
              );
            },
          };
          await createContentWork({
            storage,
            access: createContentWorkAccess(systemClock),
            readConsent: createAuthConsentReader({
              url: `${process.env.CONTENT_TEST_CONSENT ?? 'http://127.0.0.1:1'}/internal/v1/consents:read`,
              serviceTokenId: 'fixture.access',
              serviceTokenSecret: 'fixture-secret',
            }),
            routeKey: Buffer.from(process.env.CONTENT_TEST_ROUTE_KEY ?? '', 'base64url'),
            fetchConfig: { allowedHosts: ['images.example.org'] },
            registerErasureParticipant: process.env.CONTENT_TEST_DISABLE_ERASURE_PARTICIPANT !== 'true',
          }).register(testContext);
          const effectNames = new Set(['content_author_erasure', 'content_media_image']);
          const effects = contentEffects(context.pool, context.client).filter((effect) => effectNames.has(effect.name));
          if (effects.length !== effectNames.size) throw new Error('Required native content effects are missing');
          context.addEffects(effects);
        },
      },
    ],
  );
  console.log('ready');
  for await (const line of console) {
    if (line === 'release-account-upload-index') {
      releaseAccountUploadIndex?.();
      console.log('account-upload-index-released');
    } else if (line === 'stop') {
      releaseAccountUploadIndex?.();
      await worker.stop();
      console.log('stopped');
      break;
    }
  }
}

if (process.argv.includes('--disclosure-worker')) {
  await runDisclosureWorker();
}
