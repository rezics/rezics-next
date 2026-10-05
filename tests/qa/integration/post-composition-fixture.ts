import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { spyOn } from 'bun:test';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import {
  AccessAdmissionRegistry,
  type VerifiedPrincipal,
} from '../../../services/main/src/modules/access/admission.ts';
import { AliasRegistry } from '../../../services/main/src/modules/address/registry.ts';
import type {
  WorkActivationEnvironment,
  WorkActivationReceipt,
} from '../../../services/main/src/modules/work/activate.ts';

/** Observe the real graph responses, including fences and hydration, without replacing a read. */
export async function measurePostLayerRead<T>(fuseki: FusekiClient, read: () => Promise<T>) {
  const query = fuseki.query.bind(fuseki);
  let graphCalls = 0,
    graphRows = 0;
  const meter = spyOn(fuseki, 'query').mockImplementation(async (sparql, maxBytes) => {
    graphCalls++;
    const result = await query(sparql, maxBytes);
    graphRows += result.results?.bindings.length ?? (result.boolean === undefined ? 0 : 1);
    return result;
  });
  const started = performance.now();
  try {
    const value = await read();
    return { value, cost: { graphCalls, graphRows }, ms: Math.round(performance.now() - started) };
  } finally {
    meter.mockRestore();
  }
}

/** Placement reads need Access, graph and composition objects, without media or Content fixtures. */
export async function startPostCompositionStack() {
  if (
    !Bun.env.REZICS_QA_RUN_ID ||
    !Bun.env.FUSEKI_URL ||
    !Bun.env.ACCESS_DATABASE_URL ||
    !Bun.env.MAIN_OBJECT_DIRECTORY ||
    !Bun.env.MAIN_DATA_EPOCH ||
    !Bun.env.MAIN_ROUTING_EPOCH
  ) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const pool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const objects = new S3ImmutableObjects({
    endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!,
    region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!,
    secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/',
  });
  const env: WorkActivationEnvironment = {
    fuseki,
    objectDirectory: Bun.env.MAIN_OBJECT_DIRECTORY,
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
    addresses: new AliasRegistry(pool),
  };
  Object.assign(env, { structureObjects: objects });
  const access = new AccessAdmissionRegistry(pool);
  access.configureBaseline(fuseki);
  const tokens = new Map<string, VerifiedPrincipal>();
  const app = createMainApp(fuseki, {
    environment: env,
    access,
    structureObjects: objects,
    account: {
      verify: async (request) => {
        const principal = tokens.get(
          request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '',
        );
        if (!principal) throw new Error('Unknown Post fixture bearer');
        return principal;
      },
    },
  });
  try {
    await objects.initialize();
  } catch (error) {
    await pool.end();
    throw error;
  }
  const member = async (name: string) => {
    const principalId = randomUUID(),
      actor = `https://rezics.com/id/${randomUUID()}`,
      token = randomUUID();
    const principal = {
      issuer: 'https://qa-post-composition.test',
      subject: `${name}-${randomUUID()}`,
    };
    tokens.set(token, principal);
    await pool.query(
      'INSERT INTO access.principal (id,account_issuer,account_subject) VALUES ($1,$2,$3)',
      [principalId, principal.issuer, principal.subject],
    );
    await pool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [actor]);
    const grant = async (scope: string, action: string) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING',
          [scope],
        );
        await client.query(
          `INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
          VALUES ($1,$2,$3,$4,now() + interval '1 hour')`,
          [randomUUID(), principalId, actor, action],
        );
        await client.query(
          `INSERT INTO access.permission_grant
          (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
          VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`,
          [randomUUID(), actor, scope, action],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };
    const send = (method: string, path: string, body?: unknown) =>
      app.handle(
        new Request(`http://main.local${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'idempotency-key': randomUUID(),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    const read = (path: string) => {
      const url = new URL(`http://main.local${path}`);
      url.searchParams.set('actingSubject', actor);
      return send('GET', `${url.pathname}${url.search}`);
    };
    return { actor, principalId, grant, send, read };
  };
  return { env, fuseki, member, stop: () => pool.end() };
}

const stores = new WeakMap<WorkActivationEnvironment, S3ImmutableObjects>();
const short = (value: string) => value.slice(-36);
async function json<T>(response: Response, status: number): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Post fixture: ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

/** Rights fixtures use the same Post/placement command as Studio. */
export async function fixtureChapter(
  env: WorkActivationEnvironment,
  send: (path: string, body: object) => Promise<Response>,
  grant: (actor: string, scope: string, action: string) => Promise<unknown>,
  book: WorkActivationReceipt,
  actor: string,
  grouped = false,
) {
  let objects = stores.get(env);
  if (!objects) {
    objects = new S3ImmutableObjects({
      endpoint: Bun.env.MAIN_S3_ENDPOINT!,
      bucket: Bun.env.MAIN_S3_BUCKET!,
      region: Bun.env.MAIN_S3_REGION!,
      accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!,
      secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
      prefix: 'semantic/structure/',
    });
    await objects.initialize();
    Object.assign(env, { structureObjects: objects });
    stores.set(env, objects);
  }
  await grant(actor, `work:edit:${book.work}`, 'work.edit');
  const composition = await json<{ structure: string; revision: string }>(
    await send('/v1/compositions', {
      profile: 'book-composition',
      work: book.work,
      mainVersion: book.mainVersion,
      actingSubject: actor,
    }),
    201,
  );
  let parent = composition.structure,
    head = composition.revision;
  if (grouped) {
    const group = await json<{ revision: string; occurrences: string[] }>(
      await send(`/v1/compositions/${short(composition.structure)}/changes`, {
        profile: 'book-composition',
        expectedHead: head,
        actingSubject: actor,
        operations: [
          {
            op: 'insert',
            role: 'group',
            parent,
            position: 'last',
            division: 'volume',
            label: { value: 'Volume', language: 'en' },
          },
        ],
      }),
      200,
    );
    head = group.revision;
    parent = group.occurrences[0]!;
  }
  const post = await json<{ post: string; revision: string }>(
    await send(`/v1/works/${short(book.work)}/chapters`, {
      profile: 'book-chapter-create-v1',
      title: 'Chapter',
      language: 'en',
      direction: 'ltr',
      parent,
      position: 'last',
      expectedCompositionHead: head,
      actingSubject: actor,
    }),
    200,
  );
  for (const [prefix, action] of [
    ['work:read', 'work.read'],
    ['content:draft', 'content.draft'],
    ['content:publish', 'content.publish'],
    ['content:search-eligibility', 'content.search-eligibility'],
  ] as const) {
    await grant(actor, `${prefix}:${post.post}`, action);
  }
  return { ...book, work: post.post, workRevision: post.revision };
}
