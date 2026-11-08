import { randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import { Pool } from 'pg';
import { bootstrapLocalShowcaseBoardCreation, PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createNativeContentSystem, type NativeContentSystem } from './support/native-system.ts';

export type ReviewLifecyclePerson = Readonly<{ accountId: string; bearer: string }>;
export type ReviewLifecycleResponse = Readonly<{
  response: Response;
  text: string;
  value: Record<string, any>;
}>;

export type ReviewLifecycleFixture = Readonly<{
  system: NativeContentSystem;
  admin: Pool;
  governance: ReviewLifecyclePerson;
  author: ReviewLifecyclePerson;
  other: ReviewLifecyclePerson;
  boardId: string;
  subjectId: string;
  question: Record<string, any>;
  call(
    method: string,
    path: string,
    options?: Readonly<{ bearer?: string; body?: unknown; key?: string; ifMatch?: string }>,
  ): Promise<ReviewLifecycleResponse>;
  subject(label: string, bearer?: string): Promise<string>;
  grantBoard(person: ReviewLifecyclePerson): Promise<void>;
  close(): Promise<void>;
}>;

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must name the migrated test database');
  return url;
}

export async function createReviewLifecycleFixture(): Promise<ReviewLifecycleFixture> {
  const system = await createNativeContentSystem({ databaseUrl: requireDatabaseUrl() });
  let admin: Pool | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await admin?.end();
    } finally {
      await system.close();
    }
  };

  try {
    await bootstrapRelease(system.database.pool, bundledRelease);
    const databaseName = (
      await system.database.pool.query<{ database_name: string }>('SELECT current_database() AS database_name')
    ).rows[0]?.database_name;
    if (!databaseName) throw new Error('Native content database name was not returned');
    const adminUrl = new URL(requireDatabaseUrl());
    adminUrl.pathname = `/${databaseName}`;
    const adminPool = new Pool({ connectionString: adminUrl.href, max: 2 });
    admin = adminPool;

    const governanceId = (
      await system.database.pool.query<{ account_id: string }>('SELECT account_id FROM access.governance_bootstrap')
    ).rows[0]?.account_id;
    if (!governanceId) throw new Error('Native governance bootstrap did not return its account');
    const governanceCredential = await system.auth.issue({
      accountId: governanceId,
      clientId: system.auth.ordinaryClient.id,
      scopes: system.auth.ordinaryScopes,
    });
    const governance = { accountId: governanceId, bearer: governanceCredential.bearer };
    // Global Board creation is a local showcase capability. Install it through
    // its native fixture helper for the governance persona instead of asking
    // ordinary HTTP grant admission to delegate an unheld action.
    const author = governance;
    const other = { accountId: system.actors.other.actor.accountId, bearer: system.actors.other.bearer };

    const call: ReviewLifecycleFixture['call'] = async (method, path, options = {}) => {
      const headers = new Headers();
      if (options.bearer) headers.set('authorization', `Bearer ${options.bearer}`);
      if (options.key !== undefined || method !== 'GET')
        headers.set('idempotency-key', JSON.stringify(options.key ?? randomUUID()));
      if (options.ifMatch !== undefined) headers.set('if-match', JSON.stringify(options.ifMatch));
      if (options.body !== undefined) headers.set('content-type', 'application/json');
      const { response } = await system.transport.capture(
        new Request(`https://content.test${path}`, {
          method,
          headers,
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        }),
      );
      const text = await response.text();
      return { response, text, value: text ? (JSON.parse(text) as Record<string, any>) : {} };
    };
    const checked = async (method: string, path: string, options: Parameters<typeof call>[2] = {}, expected = 201) => {
      const result = await call(method, path, options);
      if (result.response.status !== expected)
        throw new Error(`${method} ${path}: expected ${expected}, received ${result.response.status} ${result.text}`);
      return result;
    };

    await checked('POST', '/v1/platform/exposure/personal_library:open', { bearer: governance.bearer }, 200);
    await bootstrapLocalShowcaseBoardCreation(system.database.pool, governance.accountId);

    const subject = async (label: string, bearer = author.bearer): Promise<string> => {
      const result = await checked('POST', '/v1/subjects', {
        bearer,
        body: { type: 'schema:Book', labels: { en: label } },
      });
      const id = result.value.subject?.id;
      if (typeof id !== 'string') throw new Error('Native subject creation did not return an id');
      return id;
    };
    const subjectId = await subject('Native review lifecycle subject');
    const subjectRead = await call('GET', `/v1/subjects/${subjectId}`);
    if (subjectRead.response.status !== 200)
      throw new Error(
        `Native review subject is not publicly readable: ${subjectRead.response.status} ${subjectRead.text}`,
      );

    const createdBoard = await checked('POST', '/v1/boards', {
      bearer: author.bearer,
      body: {
        conceptId: subjectId,
        title: 'Native review lifecycle board',
        purpose: 'reviews',
        visibility: 'published',
      },
    });
    const boardId = createdBoard.value.board?.id;
    if (typeof boardId !== 'string') throw new Error('Native reviews board creation did not return an id');
    const grantBoard = async (person: ReviewLifecyclePerson) => {
      await checked('POST', '/v1/grants', {
        bearer: governance.bearer,
        body: {
          resource: { route: routeOf(boardId), id: boardId },
          subject: { kind: 'account', id: person.accountId },
          actions: ['thread:create', 'board:read'],
          valid: '(,)',
        },
      });
    };
    await grantBoard(author);
    await grantBoard(other);
    const boardRead = await call('GET', `/v1/boards/${boardId}`);
    if (
      boardRead.response.status !== 200 ||
      boardRead.value.board?.purpose !== 'reviews' ||
      boardRead.value.board?.visibility !== 'published' ||
      boardRead.value.board?.realmId !== null
    )
      throw new Error(`Native reviews board is not publicly readable: ${boardRead.response.status} ${boardRead.text}`);

    const questionRead = await call('GET', `/v1/rating-questions/${STANDARD_QUESTION_ID}`);
    const question = questionRead.value;
    if (
      questionRead.response.status !== 200 ||
      question.id !== STANDARD_QUESTION_ID ||
      question.label !== 'How much did you like this work?' ||
      question.grain !== 'work' ||
      question.scale?.min !== 0 ||
      question.scale?.max !== 20 ||
      question.scale?.displayStep !== 1
    )
      throw new Error(
        `Released standard work rating question mismatch: ${questionRead.response.status} ${questionRead.text}`,
      );

    return {
      system,
      admin: adminPool,
      governance,
      author,
      other,
      boardId,
      subjectId,
      question,
      call,
      subject,
      grantBoard,
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Native review fixture setup failed', { cause: error });
    }
    throw error;
  }
}

export function requestKey(label: string): string {
  return `${label}-${randomUUID()}`;
}
