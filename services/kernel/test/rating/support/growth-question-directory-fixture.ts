import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccess } from '../../../src/access/index.ts';
import { GLOBAL_CONTEXT } from '../../../src/access/gates/catalogue.ts';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { createKernel } from '../../../src/http/kernel.ts';
import { newId, routeOf } from '../../../src/route/route.ts';
import { bootstrapRelease } from '../../../src/semantic/definitions.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../../support/growth.ts';

export const QUESTION_DIRECTORY_SCALES = [64, 512, 4096] as const;
export const QUESTION_DIRECTORY_STANDARD_ID = '00000000-0000-7000-8000-000000000001';

export type DirectoryPrincipal = 'reader' | 'outsider' | 'anonymous';
export type DirectoryQuestion = {
  readonly id: string;
  readonly revision: number;
  readonly label: string;
  readonly grain: 'work' | 'release' | 'episode' | 'character';
  readonly scale: { readonly min: number; readonly max: number; readonly displayStep: number };
};

const routeKey = new Uint8Array(32).fill(94);
const QUESTION_ID_PREFIX = '80000000-0000-7000-8000-';

export function directoryQuestionId(prefix: string, ordinal: number): string {
  return `${prefix}${ordinal.toString(16).padStart(12, '0')}`;
}

export async function createGrowthQuestionDirectoryFixture() {
  const database = await openGrowthDatabase();
  database.pool.options.max = 1;
  await bootstrapRelease(database.pool, bundledRelease);

  const accountIds = { reader: newId(0x2401), outsider: newId(0x2401) };
  const signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'rating-question-directory', alg: 'ES256' };
  const credential = (principal: Exclude<DirectoryPrincipal, 'anonymous'>, clientId: string, scope: string) =>
    new SignJWT({
      client_id: clientId,
      scope,
      authn_epoch: 1,
      auth_time: Math.floor(Date.now() / 1000),
      amr: ['pwd'],
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'rating-question-directory', typ: 'at+jwt' })
      .setIssuer('https://auth.example.test')
      .setAudience('https://api.rezics.test')
      .setSubject(accountIds[principal])
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(signing.privateKey);

  const app = createKernel({
    pool: database.pool,
    writeRate: createWriteRateLimiter({
      secret: 'rating-question-directory-write-rate-secret-32-bytes',
      overrides: JSON.stringify({ 'new-account': { write: { maximum: 10000, seconds: 60 } } }),
    }),
    ratePeer: () => '127.0.0.1',
    routeKey,
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(24)]]) },
    access: (config) =>
      createAccess({
        ...config,
        auth: {
          issuer: 'https://auth.example.test',
          audience: 'https://api.rezics.test',
          jwksUrl: 'https://auth.example.test/jwks',
          fetch: async () => Response.json({ keys: [jwk] }),
        },
      }),
  });

  for (const accountId of Object.values(accountIds))
    await database.admin.query(
      `INSERT INTO access.account(route, account_id, kind, state, transaction_id)
       VALUES ($1, $2, 'actor', 'active', $2)`,
      [routeOf(accountId), accountId],
    );

  const tokens = new Map<Exclude<DirectoryPrincipal, 'anonymous'>, string>();
  for (const principal of Object.keys(accountIds) as (keyof typeof accountIds)[])
    tokens.set(principal, await credential(principal, 'rating-question-directory', 'subject:read realm:read'));

  async function request(
    path: string,
    principal: DirectoryPrincipal = 'reader',
    bearer?: string,
  ): Promise<Response> {
    return app.handle(
      new Request(`http://kernel.test${path}`, {
        headers: {
          'x-request-id': 'rating-question-directory-growth',
          ...(principal === 'anonymous' ? {} : { authorization: `Bearer ${bearer ?? tokens.get(principal)!}` }),
        },
      }),
    );
  }

  async function seedQuestionRange(
    prefix: string,
    first: number,
    last: number,
    labelPrefix = 'Growth directory question ',
  ): Promise<DirectoryQuestion[]> {
    if (first > last) return [];
    const result = await database.admin.query(
      `INSERT INTO rating.question (id, owner_id, revision, label, grain, minimum_units, maximum_units, step_units)
       SELECT ($1::text || lpad(to_hex(n), 12, '0'))::uuid, $2, 1, $3 || n::text, 'work', 0, 20, 1
       FROM generate_series($4::int, $5::int) AS n`,
      [prefix, accountIds.reader, labelPrefix, first, last],
    );
    if (result.rowCount !== last - first + 1)
      throw new Error(`Expected to seed ${last - first + 1} rating questions, inserted ${result.rowCount}`);
    return Array.from({ length: last - first + 1 }, (_, offset) => {
      const ordinal = first + offset;
      return {
        id: directoryQuestionId(prefix, ordinal),
        revision: 1,
        label: `${labelPrefix}${ordinal}`,
        grain: 'work',
        scale: { min: 0, max: 20, displayStep: 1 },
      };
    });
  }

  async function updateQuestion(question: DirectoryQuestion): Promise<void> {
    await database.admin.query(
      `UPDATE rating.question
       SET revision = $2, label = $3, grain = $4,
           minimum_units = $5, maximum_units = $6, step_units = $7
       WHERE id = $1`,
      [
        question.id,
        question.revision,
        question.label,
        question.grain,
        question.scale.min,
        question.scale.max,
        question.scale.displayStep,
      ],
    );
  }

  async function seedClosedDenialHistory(first: number, last: number): Promise<void> {
    if (first > last) return;
    const result = await database.admin.query(
      `INSERT INTO access.resource_denial
         (route, resource_id, subject_id, subject_role, action, reason, valid, transaction_id)
       SELECT $1, $2, $3, '', 'definitions:read', 'resource',
              tstzrange('2000-01-01T00:00:00Z'::timestamptz + n * interval '2 days',
                        '2000-01-02T00:00:00Z'::timestamptz + n * interval '2 days', '[)'),
              ('90000000-0000-7000-8000-' || lpad(to_hex(n), 12, '0'))::uuid
       FROM generate_series($4::int, $5::int) AS n`,
      [GLOBAL_CONTEXT.route, GLOBAL_CONTEXT.id, accountIds.reader, first, last],
    );
    if (result.rowCount !== last - first + 1)
      throw new Error(`Expected to seed ${last - first + 1} closed denial intervals, inserted ${result.rowCount}`);
  }

  async function seedCurrentDenial(): Promise<void> {
    await database.admin.query(
      `INSERT INTO access.resource_denial (route, resource_id, subject_id, action, reason, valid, transaction_id)
       VALUES ($1, $2, $3, 'definitions:read', 'resource',
               tstzrange('2025-01-01T00:00:00Z'::timestamptz, NULL, '[)'), $4)`,
      [GLOBAL_CONTEXT.route, GLOBAL_CONTEXT.id, accountIds.reader, randomUUID()],
    );
  }

  async function reset(): Promise<void> {
    await database.admin.query('DELETE FROM rating.question WHERE owner_id = $1', [accountIds.reader]);
    await database.admin.query(
      `DELETE FROM access.resource_denial
       WHERE route = $1 AND resource_id = $2 AND subject_id = $3 AND action = 'definitions:read'`,
      [GLOBAL_CONTEXT.route, GLOBAL_CONTEXT.id, accountIds.reader],
    );
  }

  async function close(): Promise<void> {
    try {
      await reset();
    } finally {
      await database.close();
    }
  }

  return {
    database,
    accountIds,
    request,
    issueCredential: credential,
    seedQuestionRange,
    updateQuestion,
    seedClosedDenialHistory,
    seedCurrentDenial,
    reset,
    close,
  };
}

export const DIRECTORY_SELECTED_PREFIX = QUESTION_ID_PREFIX;
