import { randomUUID, createHash } from 'node:crypto';
import { createCurrentConsentReader } from '@rezics/auth/current-consent';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { Pool } from 'pg';
import { createAuthConsentReader } from '../../src/request/auth-consent.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createImageJob } from '../../src/content/image-job.ts';
import type { MediaStorage } from '../../src/content/media-storage.ts';
import { createContentWorkAccess } from '../../src/content/register.ts';
import { contentEffects } from '../../src/content/relays.ts';
import pagePosts from '../../src/content/page-erasure-posts.sql';
import { createContentOperationClient, createContentWork } from '../../src/content/work.ts';
import { effectsRelay } from '../../src/events/effects.ts';
import { startRelays } from '../../src/events/relays.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork } from '../../src/work/registry.ts';
import { workerTestEnv } from '../support/worker-env.ts';
import { imageSource } from './support/media-fixtures.ts';
import { observeSql } from './support/sql-observer.ts';
import { createMediaStorage } from './support/storage.ts';
import { contentGovernanceCredential, createContentSystem, type ContentCredential } from './support/system.ts';

export type NativePost = { id: string; revisionId: string };
export type NativeScope = {
  threadId: string;
  route: number;
  posts: NativePost[];
  otherPosts: NativePost[];
  revisionCount: number;
  mediaId?: string;
};
export type NativeCall = {
  response: Response;
  text: string;
  value: Record<string, any> | null;
};
type Worker = {
  pageBoundary(): Promise<void>;
  release(): Promise<void>;
  crash(): Promise<void>;
  stop(): Promise<void>;
};

/** Auth owns its process-global executor. As in the native reaction relay fixture,
 * Content work owns a separate process, with one supported composition per launch.
 * The bridge carries Auth's real current consent fact and external object bytes;
 * no account, permission, command outcome or workflow state is synthesized here.
 */
export async function createAuthorErasureFixture(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
  const system = await createContentSystem({ databaseUrl });
  const pool = system.database.pool;
  const objects = createMediaStorage();
  let client: Awaited<ReturnType<typeof createWorkClient>> | undefined;
  let bridge: ReturnType<typeof Bun.serve> | undefined;
  let worker: Worker | undefined;
  const secret = randomUUID();
  const executorId = `author-erasure-${randomUUID()}`;
  try {
    client = await createWorkClient(pool.options.connectionString!, pool);
    const workClient = client;
    const clock = () => new Date();
    // This is the same native Access instance and the same mounted product routes.
    // A fixture budget permits the documented growth populations through real commands.
    const app = createKernel({
      pool,
      access: () => system.access,
      routeKey: system.routeKey,
      tokens: system.tokenKeys,
      clock,
      workClient,
      content: { workflows: createContentOperationClient({ pool, client: workClient, clock }) },
      writeRate: createWriteRateLimiter({
        secret: randomUUID() + randomUUID(),
        overrides: JSON.stringify({ 'new-account': { write: { maximum: 100_000, seconds: 86_400 } } }),
      }),
      ratePeer: () => '127.0.0.1',
    });
    const author = system.actors.author;
    const other = system.actors.other;
    const governance = await contentGovernanceCredential(system);
    const consent = createCurrentConsentReader({ database: system.database.authPool });
    bridge = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (request.headers.get('authorization') !== `Bearer ${secret}`) return new Response(null, { status: 403 });
        const url = new URL(request.url);
        if (url.pathname === '/internal/v1/consents:read' && request.method === 'POST')
          return Response.json(await consent.readCurrentConsent(await request.json()));
        if (url.pathname === '/object') {
          const key = url.searchParams.get('key')!;
          if (request.method === 'GET') {
            const bytes = await objects.storage.get(key);
            return bytes === null ? new Response(null, { status: 404 }) : new Response(Buffer.from(bytes));
          }
          if (request.method === 'PUT') {
            await objects.storage.put(key, new Uint8Array(await request.arrayBuffer()), {
              mediaType: request.headers.get('content-type')!,
            });
            return new Response(null, { status: 204 });
          }
        }
        if (url.pathname === '/prefix' && request.method === 'DELETE') {
          await objects.storage.deletePrefix(url.searchParams.get('prefix')!);
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 404 });
      },
    });

    async function call(
      method: string,
      path: string,
      options: { bearer?: string; key?: string; body?: unknown; headers?: Record<string, string> } = {},
    ): Promise<NativeCall> {
      const headers = new Headers(options.headers);
      if (options.bearer) headers.set('authorization', `Bearer ${options.bearer}`);
      if (options.key !== undefined) headers.set('idempotency-key', JSON.stringify(options.key));
      if (options.body !== undefined) headers.set('content-type', 'application/json');
      const response = await app.handle(
        new Request(`https://content.test${path}`, {
          method,
          headers,
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        }),
      );
      const text = await response.text();
      return { response, text, value: text ? JSON.parse(text) : null };
    }
    async function command(
      path: string,
      body: unknown,
      credential: ContentCredential = author,
      status = 201,
      method = 'POST',
      headers?: Record<string, string>,
    ) {
      const result = await call(method, path, {
        bearer: credential.bearer,
        key: randomUUID(),
        body,
        ...(headers === undefined ? {} : { headers }),
      });
      if (result.response.status !== status)
        throw new Error(`${method} ${path}: ${result.response.status} ${result.text}`);
      return result.value!;
    }
    await bootstrapRelease(pool, bundledRelease);
    const { subject: scheme } = await command('/v1/subjects', {
      type: 'skos:ConceptScheme',
      labels: { en: 'Native author erasure' },
    });
    const { subject: concept } = await command('/v1/subjects', {
      type: 'skos:Concept',
      labels: { en: 'Native author erasure board' },
      statements: {
        'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.id } }],
      },
    });
    const { space } = await command('/v1/spaces', { title: 'Native author erasure' });
    const { realm } = await command('/v1/realms', {
      spaceId: space.spaceId,
      title: 'Native author erasure',
      visibility: 'public',
      contextId: GLOBAL_CONTEXT,
    });
    await command(`/v1/realms/${realm.realmId}/boardScheme`, { schemeId: scheme.id }, author, 200, 'PUT', {
      'if-match': JSON.stringify(realm.headRevisionId),
    });
    const { board } = await command(`/v1/realms/${realm.realmId}/boards`, {
      conceptId: concept.id,
      title: 'Native author erasure',
      visibility: 'published',
    });

    async function reply(scope: Pick<NativeScope, 'threadId'>, credential: ContentCredential, text: string) {
      const { post } = await command(
        `/v1/threads/${scope.threadId}/posts`,
        {
          body: fromPlainText(text),
          licence: 'CC0-1.0',
          subjectIds: [],
          boardId: board.id,
        },
        credential,
      );
      return post as NativePost;
    }
    async function revise(post: NativePost, text: string, credential = author, mediaIds?: string[]) {
      const result = await command(
        `/v1/posts/${post.id}/revisions`,
        {
          body: fromPlainText(text),
          ...(mediaIds === undefined ? {} : { mediaIds }),
        },
        credential,
        200,
        'POST',
        { 'if-match': JSON.stringify(post.revisionId) },
      );
      post.revisionId = result.post.revisionId;
    }
    async function claimMedia(scope: Pick<NativeScope, 'threadId'>, post: NativePost) {
      const source = await imageSource('tiny');
      const key = randomUUID();
      const sha256 = createHash('sha256').update(source.bytes).digest('hex');
      const reserved = await call('POST', '/v1/media', {
        bearer: author.bearer,
        key,
        body: {
          containerId: scope.threadId,
          purpose: 'post-image',
          mediaType: source.type,
          byteCount: source.bytes.length,
          sha256,
        },
      });
      if (reserved.response.status !== 201)
        throw new Error(`Media reservation: ${reserved.response.status} ${reserved.text}`);
      const mediaId = reserved.value!.media.id as string;
      // The supported confidential website credential belongs to this same author.
      await objects.storage.put(`m/${mediaId}/original`, source.bytes, { mediaType: source.type });
      await command(
        `/v1/media/${mediaId}:complete`,
        {
          containerId: scope.threadId,
          reservationRequestId: key,
          byteCount: source.bytes.length,
          sha256,
        },
        system.actors.worker,
        200,
      );
      const image = await createImageJob(pool, objects.storage).process(mediaId);
      if (image.state !== 'available') throw new Error(`Native image producer returned ${image.state}`);
      await revise(post, 'Private author claimed image sentinel', author, [mediaId]);
      return mediaId;
    }
    async function scope(count = 205, revisions = 3, withMedia = false): Promise<NativeScope> {
      const { thread } = await command('/v1/threads', {
        title: 'Native author erasure scope',
        body: fromPlainText('Private author opening sentinel'),
        licence: 'CC0-1.0',
        subjectIds: [],
        boardId: board.id,
        visibility: 'published',
      });
      const value: NativeScope = {
        threadId: thread.id,
        route: routeOf(thread.id)!,
        posts: [thread.firstPost],
        otherPosts: [],
        revisionCount: count * revisions,
      };
      for (let index = 1; index < count; index++) {
        value.posts.push(await reply(value, author, `Private author post sentinel ${index}`));
        if (index === 99 || index === 100)
          value.otherPosts.push(await reply(value, other, `Surviving other author ${index}`));
      }
      // Always retain a positive unrelated-author control, even for a one-post scope.
      value.otherPosts.push(await reply(value, other, 'Surviving unrelated author sentinel'));
      for (const post of value.posts)
        for (let revision = 1; revision < revisions; revision++)
          await revise(post, `Private author historical sentinel ${post.id} ${revision}`);
      for (const post of value.otherPosts) await revise(post, 'Surviving other author revision');
      if (withMedia) {
        value.mediaId = await claimMedia(value, value.posts[0]!);
        value.revisionCount++;
      }
      return value;
    }
    return {
      system,
      pool,
      client: workClient,
      app,
      author,
      other,
      governance,
      objects,
      consent,
      call,
      command,
      scope,
      reply,
      revise,
      claimMedia,
      async startWorker(pauseAtSecondPage = false) {
        if (worker) throw new Error('Stop the owned Content worker before restarting it');
        worker = await spawnWorker({
          databaseUrl: pool.options.connectionString!,
          routeKey: system.routeKey,
          bridge: bridge!.url.href,
          secret,
          executorId,
          pauseAtSecondPage,
        });
        return worker;
      },
      async stopWorker(crash = false) {
        const running = worker;
        worker = undefined;
        if (running) await (crash ? running.crash() : running.stop());
      },
      async close() {
        try {
          await worker?.stop();
        } finally {
          try {
            await bridge!.stop(true);
          } finally {
            try {
              await workClient.close();
            } finally {
              objects.close();
              await system.close();
            }
          }
        }
      },
    };
  } catch (error) {
    try {
      await worker?.stop();
    } finally {
      try {
        await bridge?.stop(true);
      } finally {
        try {
          await client?.close();
        } finally {
          objects.close();
          await system.close();
        }
      }
    }
    throw error;
  }
}
export type AuthorErasureFixture = Awaited<ReturnType<typeof createAuthorErasureFixture>>;

type WorkerOptions = {
  databaseUrl: string;
  routeKey: Uint8Array;
  bridge: string;
  secret: string;
  executorId: string;
  pauseAtSecondPage: boolean;
};
async function spawnWorker(options: WorkerOptions): Promise<Worker> {
  const child = Bun.spawn([process.execPath, import.meta.path, '--author-erasure-worker'], {
    env: {
      ...process.env,
      ...workerTestEnv({ KERNEL_ROUTE_KEY: Buffer.from(options.routeKey).toString('base64url') }),
      DATABASE_URL: options.databaseUrl,
      AUTHOR_ERASURE_BRIDGE: options.bridge,
      AUTHOR_ERASURE_SECRET: options.secret,
      AUTHOR_ERASURE_EXECUTOR: options.executorId,
      AUTHOR_ERASURE_PAUSE: options.pauseAtSecondPage ? '1' : '0',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let output = '';
  const read = (async () => {
    for await (const chunk of child.stdout) output += new TextDecoder().decode(chunk);
  })();
  const errors = new Response(child.stderr).text();
  async function until(predicate: () => boolean) {
    const deadline = Date.now() + 120_000;
    while (!predicate()) {
      if (child.exitCode !== null)
        throw new Error(`Author erasure worker exited (${child.exitCode})\n${output}\n${await errors}`);
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for native author erasure worker\n${output}`);
      await Bun.sleep(10);
    }
  }
  try {
    await until(() => output.includes('author-erasure:ready'));
  } catch (error) {
    child.kill('SIGKILL');
    await child.exited;
    await read;
    throw error;
  }
  return {
    pageBoundary: () => until(() => output.includes('author-erasure:page-boundary')),
    async release() {
      child.stdin.write('release\n');
      await until(() => output.includes('author-erasure:released'));
    },
    async crash() {
      child.kill('SIGKILL');
      await child.exited;
      await read;
      await errors;
    },
    async stop() {
      if (child.exitCode !== null)
        throw new Error(`Author erasure worker exited (${child.exitCode})\n${output}\n${await errors}`);
      child.stdin.write('stop\n');
      child.stdin.end();
      try {
        await until(() => child.exitCode !== null);
      } catch (error) {
        child.kill('SIGKILL');
        await child.exited;
        await read;
        throw error;
      }
      await read;
      if (child.exitCode !== 0 || !output.includes('author-erasure:stopped'))
        throw new Error(`Author erasure worker did not close (${child.exitCode})\n${output}\n${await errors}`);
    },
  };
}

async function runWorker() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 10 });
  let client: Awaited<ReturnType<typeof createWorkClient>> | undefined;
  const observer = observeSql(pool);
  // The production post seek's second invocation is after the first logical page
  // and its native progress checkpoint. Holding this real query changes no result.
  const barrier =
    process.env.AUTHOR_ERASURE_PAUSE === '1'
      ? observer.hold({ statement: pagePosts.sql, occurrence: 2 }, 'before')
      : undefined;
  let work: Awaited<ReturnType<typeof composeWork>> | undefined;
  let relay: ReturnType<typeof startRelays> | undefined;
  const bridge = process.env.AUTHOR_ERASURE_BRIDGE!;
  const secret = process.env.AUTHOR_ERASURE_SECRET!;
  const transport = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${secret}`);
    return fetch(new URL(path, bridge), { ...init, headers });
  };
  const storage: MediaStorage = {
    async get(key) {
      const response = await transport(`/object?key=${encodeURIComponent(key)}`);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Object get failed (${response.status})`);
      return new Uint8Array(await response.arrayBuffer());
    },
    async put(key, bytes, options) {
      const response = await transport(`/object?key=${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: Buffer.from(bytes),
        headers: { 'content-type': options.mediaType },
      });
      if (response.status !== 204) throw new Error(`Object put failed (${response.status})`);
    },
    async deletePrefix(prefix) {
      const response = await transport(`/prefix?prefix=${encodeURIComponent(prefix)}`, { method: 'DELETE' });
      if (response.status !== 204) throw new Error(`Object purge failed (${response.status})`);
    },
  };
  try {
    client = await createWorkClient(process.env.DATABASE_URL!, pool);
    const workClient = client;
    const clock = () => new Date();
    const module = createContentWork({
      access: createContentWorkAccess(clock, pool),
      readConsent: createAuthConsentReader({
        url: new URL('/internal/v1/consents:read', bridge).href,
        serviceTokenId: 'native-worker',
        serviceTokenSecret: secret,
        fetch: (url, init) => transport(new URL(url).pathname, init),
      }),
      storage,
      routeKey: Buffer.from(process.env.KERNEL_ROUTE_KEY!, 'base64url'),
      fetchConfig: { allowedHosts: [] },
      collectionPartitions: [0],
    });
    work = await composeWork(
      [
        {
          name: module.name,
          async register(context) {
            await module.register(context);
            context.addEffects(contentEffects(pool, workClient));
          },
        },
      ],
      {
        pool,
        client: workClient,
        databaseUrl: process.env.DATABASE_URL!,
        executorId: process.env.AUTHOR_ERASURE_EXECUTOR!,
        clock,
      },
    );
    await work.launch();
    relay = startRelays(pool, [effectsRelay(pool, work.effects)], { intervalMs: 5, concurrency: 2 });
    if (barrier) void barrier.entered.then(() => console.log('author-erasure:page-boundary'));
    console.log('author-erasure:ready');
    for await (const line of console) {
      if (line === 'release') {
        barrier?.release();
        console.log('author-erasure:released');
      } else if (line === 'stop') break;
      else throw new Error(`Unknown native worker control: ${line}`);
    }
  } finally {
    barrier?.release();
    try {
      await relay?.stop();
    } finally {
      try {
        await work?.shutdown();
      } finally {
        try {
          await observer.close();
        } finally {
          try {
            await client?.close();
          } finally {
            await pool.end();
          }
        }
      }
    }
  }
  console.log('author-erasure:stopped');
}

if (process.argv.includes('--author-erasure-worker')) await runWorker();
