import { randomUUID } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { fromPlainText } from '@rezics/document';
import { Pool } from 'pg';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { threadTarget } from '../../src/content/commands.ts';
import { CONTENT_QUEUES } from '../../src/content/work-contract.ts';
import { registerContent } from '../../src/content/register.ts';
import { effectsRelay, effectWorkflowId, type Effect } from '../../src/events/effects.ts';
import { readBatch, type CloudEvent, type Envelope } from '../../src/events/log.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { createWorkClient, WORK_APPLICATION } from '../../src/work/client.ts';
import { composeWork, type WorkModule } from '../../src/work/registry.ts';
import { workerTestEnv } from '../support/worker-env.ts';
import {
  createReactionRelayBase,
  readPartitionPosition,
  type CallOptions,
  type CallResult,
  type NativePerson,
  type ReactionRelayBase,
} from './reaction-relay-convergence-fixture.ts';

export type Sort = 'newest' | 'active' | 'hot';
export const sorts = ['newest', 'active', 'hot'] as const;
export type RankedThread = {
  id: string;
  postId: string;
  boardId: string;
  createdAt: string;
  activityAt: string;
  score: number;
  reactions: Record<string, number>;
};
export type BoardPage = {
  threads: {
    id: string;
    boardId: string;
    title: string;
    visibility: string;
    firstPost: { id: string; body: unknown };
  }[];
  next: string | null;
  rankRefreshedAt: string | null;
};

export function listing(boardId: string, sort: Sort, cursor?: string, limit = 3, query?: string): string {
  return `/v1/boards/${boardId}/threads?${new URLSearchParams({
    sort,
    limit: String(limit),
    ...(cursor === undefined ? {} : { cursor }),
    ...(query === undefined ? {} : { query }),
  })}`;
}

// Independent expression of the documented formula: do not derive an expectation from materialized ranks.
export function expectedRank(score: number, activityAt: string, at: string): number {
  const age = Math.max(0, Date.parse(at) - Date.parse(activityAt));
  return age > 7 * 24 * 3_600_000 ? 0 : Math.log10(Math.max(2, score + 2)) / (age / 3_600_000 + 2) ** 1.8;
}
export function expectedOrder(threads: readonly RankedThread[], sort: Sort, at: string): string[] {
  return [...threads]
    .sort((a, b) => {
      if (sort === 'newest') return Date.parse(b.createdAt) - Date.parse(a.createdAt) || compare(b.id, a.id);
      const rank = (thread: RankedThread) =>
        expectedRank(thread.score, sort === 'active' ? thread.activityAt : thread.createdAt, at);
      return rank(b) - rank(a) || compare(a.id, b.id);
    })
    .map(({ id }) => id);
}
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
export function plus(at: string, minutes: number): string {
  return new Date(Date.parse(at) + minutes * 60_000).toISOString();
}
export function requireStatus(result: CallResult, status: number): void {
  if (result.response.status !== status)
    throw new Error(`Expected HTTP ${status}, received ${result.response.status}: ${result.text}`);
}

export type RankingRuntime = {
  consume(envelopes: readonly Envelope[]): Promise<void>;
  replay(event: CloudEvent): Promise<void>;
  refresh(at: string): Promise<void>;
  stop(): Promise<void>;
};

/** Real native Auth/Access; only this fixture's kernel clock and pool may be injected. */
export class RankingWorld {
  readonly start = new Date().toISOString();
  private now = this.start;
  private realmId: string | undefined;
  private readonly administrators = new Set<string>();
  private readonly kernel: ReturnType<typeof createKernel>;
  constructor(
    readonly base: ReactionRelayBase,
    readonly pool = base.system.database.pool,
  ) {
    this.kernel = createKernel({
      pool,
      routeKey: base.system.routeKey,
      tokens: base.system.tokenKeys,
      access: () => base.system.access,
      clock: () => new Date(this.now),
      content: { cursorNow: () => Date.parse(this.now) },
      requestDeadlineMs: 30_000,
      writeRate: createWriteRateLimiter({
        secret: randomUUID() + randomUUID(),
        overrides: JSON.stringify({ 'new-account': { write: { maximum: 100_000, seconds: 86_400 } } }),
      }),
    });
  }
  async time(at: string): Promise<void> {
    this.now = at;
    await this.base.system.clock.setCommandTime(at);
  }
  async call(method: string, path: string, options: CallOptions = {}): Promise<CallResult> {
    const headers = new Headers(options.headers);
    if (options.bearer) headers.set('authorization', `Bearer ${options.bearer}`);
    if (options.key !== undefined) headers.set('idempotency-key', JSON.stringify(options.key));
    if (options.body !== undefined || options.rawBody !== undefined) headers.set('content-type', 'application/json');
    const response = await this.kernel.handle(
      new Request(`https://content.test${path}`, {
        method,
        headers,
        ...(options.body === undefined && options.rawBody === undefined
          ? {}
          : { body: options.rawBody ?? JSON.stringify(options.body) }),
      }),
    );
    const text = await response.text();
    return { response, text, value: text ? JSON.parse(text) : null };
  }
  async command(
    method: string,
    path: string,
    body: unknown,
    person = this.base.author,
    status = 201,
    key = randomUUID(),
  ) {
    const result = await this.call(method, path, { bearer: person.bearer, key, body });
    requireStatus(result, status);
    return result.value!;
  }
  async board(visibility: 'published' | 'protected' = 'published'): Promise<string> {
    if (!this.realmId) {
      const space = await this.command('POST', '/v1/spaces', {
        title: `Ranking space ${randomUUID()}`,
        summary: 'Native ranking space',
      });
      const realm = await this.command('POST', '/v1/realms', {
        spaceId: space.space.spaceId,
        title: `Ranking realm ${randomUUID()}`,
        summary: 'Public container for independent board privacy',
        visibility: 'public',
        contextId: GLOBAL_CONTEXT,
      });
      this.realmId = realm.realm.realmId as string;
      const scheme = await this.call('PUT', `/v1/realms/${this.realmId}/boardScheme`, {
        bearer: this.base.author.bearer,
        key: randomUUID(),
        body: { schemeId: this.base.schemeId },
        headers: { 'if-match': JSON.stringify(realm.realm.headRevisionId) },
      });
      requireStatus(scheme, 200);
    }
    const concept = await this.command('POST', '/v1/subjects', {
      type: 'skos:Concept',
      labels: { en: `Ranking board concept ${randomUUID()}` },
      statements: {
        'skos:inScheme': [
          {
            property: { id: 'skos:inScheme' },
            value: { type: 'value', content: this.base.schemeId },
          },
        ],
      },
    });
    const result = await this.command('POST', `/v1/realms/${this.realmId}/boards`, {
      conceptId: concept.subject.id,
      title: `Native ranking ${randomUUID()}`,
      visibility,
    });
    return result.board.id as string;
  }
  grantBody(id: string, person: NativePerson, actions: readonly string[]) {
    return {
      resource: { route: routeOf(id)!, id },
      subject: { kind: 'account', id: person.accountId },
      actions,
      valid: '(,)',
    };
  }
  private async administrator(id: string): Promise<void> {
    if (this.administrators.has(id)) return;
    // Governance delegates only its actual global-reach management action. The resource creator still has to
    // hold every read/create action it grants, under the ordinary same-resource grant formula.
    await this.command(
      'POST',
      '/v1/grants',
      this.grantBody(id, this.base.author, ['access:grant']),
      this.base.governance,
    );
    this.administrators.add(id);
  }
  async grant(id: string, person: NativePerson, actions: readonly string[]): Promise<void> {
    const grantor = actions.every((action) => action === 'moderation:takedown')
      ? this.base.governance
      : this.base.author;
    if (grantor === this.base.author) await this.administrator(id);
    await this.command('POST', '/v1/grants', this.grantBody(id, person, actions), grantor);
  }
  async revoke(id: string, person: NativePerson, actions: readonly string[]): Promise<void> {
    await this.administrator(id);
    await this.command('POST', '/v1/grants:revoke', this.grantBody(id, person, actions), this.base.author, 200);
  }
  /** A checkpoint is capture infrastructure; business state is written exclusively by native HTTP commands. */
  async capture<T>(partition: number, action: () => Promise<T>): Promise<{ value: T; envelopes: Envelope[] }> {
    const before = await readPartitionPosition(this.pool, partition);
    const consumer = `ranking_capture_${randomUUID().replaceAll('-', '')}`;
    await this.pool.query(
      'INSERT INTO core.consumer_checkpoint(partition_no,consumer,epoch,position) VALUES ($1,$2,$3,$4)',
      [partition, consumer, before.epoch, before.position],
    );
    const value = await action();
    const after = await readPartitionPosition(this.pool, partition);
    const envelopes: Envelope[] = [];
    if (BigInt(after.position) > BigInt(before.position)) {
      const batch = await readBatch(this.pool, {
        consumer,
        partition,
        envelopes: 100,
        apply: async (items) => {
          envelopes.push(...items);
        },
      });
      if (batch.status !== 'read' || !envelopes.some((item) => item.position === BigInt(after.position)))
        throw new Error('The native command envelope was not captured through the production log reader');
    }
    return { value, envelopes };
  }
  async thread(
    boardId: string,
    at: string,
    sourcePartition?: number,
    visibility: 'published' | 'protected' = 'published',
  ) {
    await this.time(at);
    let key: string;
    let target: ReturnType<typeof threadTarget>;
    do {
      key = randomUUID();
      target = threadTarget(this.base.system.routeKey, this.base.author.accountId, key);
    } while (sourcePartition !== undefined && partitionOf(target.route) !== sourcePartition);
    const committed = await this.capture(partitionOf(target.route), () =>
      this.command(
        'POST',
        '/v1/threads',
        {
          title: `Ranking thread ${key}`,
          body: fromPlainText(`Ranking opening ${key}`),
          licence: 'CC0-1.0',
          subjectIds: [],
          boardId,
          visibility,
        },
        this.base.author,
        201,
        key,
      ),
    );
    const thread = committed.value.thread;
    if (thread.id !== target.id) throw new Error('Native command did not return its routed target');
    const result: RankedThread = {
      id: thread.id,
      postId: thread.firstPost.id,
      boardId,
      createdAt: thread.createdAt,
      activityAt: thread.createdAt,
      score: 0,
      reactions: {},
    };
    return { thread: result, envelopes: committed.envelopes };
  }
  async reply(thread: RankedThread, person: NativePerson, at: string) {
    await this.time(at);
    const committed = await this.capture(partitionOf(routeOf(thread.id)!), () =>
      this.command(
        'POST',
        `/v1/threads/${thread.id}/posts`,
        { body: fromPlainText(`Native reply ${randomUUID()}`), licence: 'CC0-1.0', subjectIds: [] },
        person,
      ),
    );
    thread.activityAt = committed.value.post.createdAt;
    return committed;
  }
  async react(thread: RankedThread, person: NativePerson, kind: 'upvote' | 'downvote' | 'love', key = randomUUID()) {
    const committed = await this.capture(partitionOf(routeOf(person.accountId)!), () =>
      this.command('PUT', `/v1/threads/${thread.id}/reaction`, { kind }, person, 200, key),
    );
    thread.reactions[kind] = (thread.reactions[kind] ?? 0) + 1;
    thread.score += kind === 'upvote' ? 1 : kind === 'downvote' ? -1 : 0;
    return { ...committed, key };
  }
  async page(boardId: string, sort: Sort, bearer?: string, cursor?: string, limit = 3): Promise<BoardPage> {
    const result = await this.call(
      'GET',
      listing(boardId, sort, cursor, limit),
      bearer === undefined ? {} : { bearer },
    );
    requireStatus(result, 200);
    return result.value as BoardPage;
  }
  async walk(
    boardId: string,
    sort: Sort,
    bearer?: string,
    cursor?: string,
  ): Promise<{ ids: string[]; pages: BoardPage[] }> {
    const ids: string[] = [];
    const pages: BoardPage[] = [];
    const cursors = new Set<string>();
    for (let count = 0; count < 100; count++) {
      const page = await this.page(boardId, sort, bearer, cursor);
      pages.push(page);
      ids.push(...page.threads.map(({ id }) => id));
      if (page.next === null) return { ids, pages };
      if (cursors.has(page.next)) throw new Error('A board walk repeated its cursor');
      cursors.add(page.next);
      cursor = page.next;
    }
    throw new Error('A board walk did not exhaust within its known population');
  }
}

export async function createRankingWorld(): Promise<RankingWorld> {
  return new RankingWorld(await createReactionRelayBase());
}

/** The observed module still registers every production workflow, effect and service, without a test replacement. */
async function composeRankingRuntime(
  pool: Pool,
  databaseUrl: string,
  routeKey: Uint8Array,
  partitions: readonly number[],
) {
  const client = await createWorkClient(databaseUrl, pool);
  const effects: Effect[] = [];
  let now = new Date();
  const module: WorkModule = {
    name: registerContent.name,
    register: (context) =>
      registerContent.register({
        ...context,
        addEffects(items) {
          effects.push(...items);
          context.addEffects(items);
        },
      }),
  };
  let work: Awaited<ReturnType<typeof composeWork>> | undefined;
  try {
    work = await composeWork([module], {
      databaseUrl,
      pool,
      client,
      executorId: `ranking-${randomUUID()}`,
      clock: () => now,
      env: workerTestEnv({
        KERNEL_ROUTE_KEY: Buffer.from(routeKey).toString('base64url'),
        CONTENT_TEST_COLLECTION_PARTITIONS: partitions.join(','),
      }),
    });
    for (const required of ['content_board_thread', 'content_reaction_count'])
      if (effects.filter(({ name }) => name === required).length !== 1)
        throw new Error(`Missing independent registered production consumer ${required}`);
    await work.launch();
    const runtime: RankingRuntime = {
      async consume(envelopes) {
        const relay = effectsRelay(pool, work!.effects);
        const barriers = new Map<number, bigint>();
        for (const envelope of envelopes) {
          const previous = barriers.get(envelope.partition) ?? 0n;
          if (envelope.position > previous) barriers.set(envelope.partition, envelope.position);
        }
        for (const [partition, position] of barriers) {
          for (;;) {
            const result = await relay.run(partition);
            if (result.status !== 'read')
              throw new Error(
                `Production effects relay refused partition ${partition}: ${JSON.stringify(result, (_key, value) =>
                  typeof value === 'bigint' ? String(value) : value,
                )}`,
              );
            if (result.position >= position) break;
            if (result.envelopes === 0) throw new Error('Production effects relay stopped before the command barrier');
          }
        }
        // A relay checkpoint is only dispatch evidence. Retrieve each actual consumer result before reading ranks.
        for (const envelope of envelopes)
          for (const [seq, event] of envelope.events.entries())
            for (const effect of effects.filter(({ types }) => types.includes(event.type)))
              await client
                .retrieveWorkflow(effectWorkflowId(envelope, seq, effect.name))
                .getResult({ pollingIntervalMs: 10 });
      },
      async replay(event) {
        const effect = effects.find(({ name }) => name === 'content_reaction_count')!;
        await effect.run(event);
      },
      async refresh(at) {
        now = new Date(at);
        const handle = await client.enqueue(
          {
            applicationName: WORK_APPLICATION,
            workflowName: 'content.board-rank.refresh',
            workflowID: `ranking-refresh:${randomUUID()}`,
            queueName: CONTENT_QUEUES.collect,
          },
          new Date(at),
          null,
        );
        await handle.getResult({ pollingIntervalMs: 10 });
      },
      async stop() {
        try {
          await work?.shutdown();
        } finally {
          await client.close();
        }
      },
    };
    return runtime;
  } catch (error) {
    try {
      await work?.shutdown();
    } finally {
      await client.close();
    }
    throw error;
  }
}

/** Growth uses the delivered native Auth-to-Content ownership transfer, on the instrumented pool. */
export async function startInlineRankingRuntime(
  world: RankingWorld,
  partitions: readonly number[],
): Promise<RankingRuntime> {
  await DBOS.shutdown({ deregister: true });
  return composeRankingRuntime(
    world.pool,
    world.pool.options.connectionString!,
    world.base.system.routeKey,
    partitions,
  );
}

/** HTTP keeps Auth alive and gives Content its own isolated process and SDK singleton. */
export async function startRankingWorker(world: RankingWorld, partitions: readonly number[]): Promise<RankingRuntime> {
  const child = Bun.spawn([process.execPath, import.meta.path, '--board-ranking-worker'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: world.pool.options.connectionString!,
      RANKING_ROUTE_KEY: Buffer.from(world.base.system.routeKey).toString('base64url'),
      RANKING_PARTITIONS: partitions.join(','),
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let output = '';
  const stdout = (async () => {
    for await (const chunk of child.stdout) output += new TextDecoder().decode(chunk);
  })();
  const stderr = new Response(child.stderr).text();
  const until = async (predicate: () => boolean, timeout = 120_000) => {
    const end = Date.now() + timeout;
    while (!predicate()) {
      if (child.exitCode !== null) throw new Error(`Board ranking worker exited with ${child.exitCode}`);
      if (Date.now() > end) throw new Error('Timed out waiting for the board ranking worker');
      await Bun.sleep(10);
    }
  };
  const kill = async () => {
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
    await stdout;
  };
  try {
    await until(() => output.includes('ranking-ready'));
  } catch (error) {
    await kill();
    throw new Error(`${String(error)}\n${output}\n${await stderr}`);
  }
  const send = async (command: string, payload?: unknown) => {
    const id = randomUUID();
    child.stdin.write(`${JSON.stringify({ id, command, payload })}\n`);
    await until(() => output.includes(`ranking:${id}:`));
    const result = output.slice(output.indexOf(`ranking:${id}:`) + `ranking:${id}:`.length).split('\n')[0];
    if (result !== 'ok') throw new Error(`Board ranking ${command}: ${result}`);
  };
  return {
    // Envelope positions cross JSON as strings and are restored only at the worker boundary.
    consume: (envelopes) =>
      send(
        'consume',
        envelopes.map((envelope) => ({ ...envelope, position: String(envelope.position) })),
      ),
    replay: (event) => send('replay', event),
    refresh: (at) => send('refresh', at),
    async stop() {
      try {
        await send('stop');
        child.stdin.end();
        await until(() => child.exitCode !== null, 60_000);
        await stdout;
        if ((await child.exited) !== 0) throw new Error(`Board ranking shutdown: ${await stderr}`);
      } finally {
        await kill();
      }
    },
  };
}

async function worker(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 10 });
  let runtime: RankingRuntime | undefined;
  try {
    runtime = await composeRankingRuntime(
      pool,
      process.env.DATABASE_URL!,
      Buffer.from(process.env.RANKING_ROUTE_KEY!, 'base64url'),
      process.env.RANKING_PARTITIONS!.split(',').map(Number),
    );
    console.log('ranking-ready');
    for await (const line of console) {
      const { id, command, payload } = JSON.parse(line);
      try {
        if (command === 'consume')
          await runtime.consume(
            payload.map((envelope: Omit<Envelope, 'position'> & { position: string }) => ({
              ...envelope,
              position: BigInt(envelope.position),
            })),
          );
        else if (command === 'replay') await runtime.replay(payload);
        else if (command === 'refresh') await runtime.refresh(payload);
        else if (command === 'stop') {
          await runtime.stop();
          runtime = undefined;
          console.log(`ranking:${id}:ok`);
          break;
        } else throw new Error(`Unknown board ranking command ${command}`);
        console.log(`ranking:${id}:ok`);
      } catch (error) {
        console.log(`ranking:${id}:error:${String(error).replaceAll('\n', ' ')}`);
      }
    }
  } finally {
    try {
      await runtime?.stop();
    } finally {
      await pool.end();
    }
  }
}
if (process.argv.includes('--board-ranking-worker')) await worker();
