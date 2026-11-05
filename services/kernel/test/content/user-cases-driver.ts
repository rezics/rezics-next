import { bundledRelease } from '@rezics/definitions/bundled';
import { normalizeDocument, parseDocument, serializeDocument, withDocumentIds } from '@rezics/document';
import type { DocumentSnapshot } from '@rezics/document';
import data from '../../../../specs/fixtures/content-user-cases.json';
import type {
  ApiResult,
  ContentUserCasesDriver,
  Figure,
  Fixture,
  HeldPage,
  Page,
  PageRequest,
  Persona,
  Post,
  RealmFigure,
  Thread,
} from '../../../../specs/content-user-cases-driver.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { createPublicRatingSource } from '../../src/rating/public-rating-source.ts';
import { createWorkClient, type WorkClient } from '../../src/work/client.ts';
import type { PublicFigureView } from '../../src/rating/public-figure-http.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { createOpenSearch, OpenSearchError } from '../../src/search/opensearch.ts';
import { withPublicRatings } from '../../src/search/rating-subject-source.ts';
import { createSearchService } from '../../src/search/service.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { seedGovernanceAuthority } from './support/disclosure-fixtures.ts';
import { TEST_REQUEST_DEADLINE_MS } from '../support/test-kernel.ts';
import {
  audience,
  governance,
  highRates,
  openUserCasesSystem,
  person,
  settleUserCasesWorker,
  startUserCasesWorker,
} from './support/user-cases-fixtures.ts';

function route(id: string): number {
  const value = routeOf(id);
  if (value === null) throw new Error(`Fixture identity is not routed: ${id}`);
  return value;
}

/** Add stable, fixture-only block identities and pass the same canonical snapshot shape as native clients. */
function requestDocument(value: unknown): DocumentSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Content fixture body must be a document snapshot');
  }
  const snapshot = value as DocumentSnapshot;
  let nextId = 0;
  const normalized = normalizeDocument({
    ...snapshot,
    doc: withDocumentIds(snapshot.doc, () => {
      nextId += 1;
      return `00000000-0000-4000-8000-${String(nextId).padStart(12, '0')}`;
    }),
  });
  return parseDocument(JSON.parse(serializeDocument(normalized)));
}

function contentInput<T extends { body: unknown }>(input: T): Omit<T, 'body'> & { body: DocumentSnapshot } {
  return { ...input, body: requestDocument(input.body) };
}

/** Only DTO field names change; missing consumer fields stay missing. */
function figure(value: PublicFigureView): Figure {
  const { scale, ...fields } = value;
  return { ...fields, units: { minimum: scale.min, maximum: scale.max, displayStep: scale.displayStep } };
}

function page<T>(value: { threads?: T[]; posts?: T[]; next: string | null; [key: string]: unknown }): Page<T> {
  const { threads, posts, ...metadata } = value;
  const items = threads ?? posts;
  if (!items) throw new Error('Native page has neither threads nor posts');
  return { ...metadata, items };
}

export async function createContentUserCasesDriver(): Promise<ContentUserCasesDriver> {
  const system = await openUserCasesSystem();
  const pool = system.database.pool;
  const prefix = `uc-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}-`;
  let fixtureTime = Date.now();
  const searchUrl = process.env.OPENSEARCH_URL;
  const search = searchUrl ? createOpenSearch(searchUrl) : undefined;
  const publicRatings = createPublicRatingSource(pool);
  const searchSubjects = withPublicRatings(subjectSource(pool, system.routeKey), publicRatings, {
    questionId: STANDARD_QUESTION_ID,
    populationId: GLOBAL_CONTEXT,
  });
  const holds = new Set<HeldPage>();
  let worker: Awaited<ReturnType<typeof startUserCasesWorker>> | undefined;
  let workClient: WorkClient | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const errors: unknown[] = [];
      for (const held of holds) {
        try {
          await held.release();
          await held.response;
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await worker?.stop();
      } catch (error) {
        errors.push(error);
      }
      try {
        await workClient?.close();
      } catch (error) {
        errors.push(error);
      }
      if (search) {
        try {
          await search.request('DELETE', `/${prefix}subjects-g1`);
        } catch (error) {
          if (!(error instanceof OpenSearchError && error.status === 404)) errors.push(error);
        }
      }
      try {
        await system.close();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) throw new AggregateError(errors, 'User cases cleanup failed');
    })());
  try {
    const moderator = await governance(system);
    const databaseUrl = pool.options.connectionString;
    if (!databaseUrl) throw new Error('Content fixture database URL is missing');
    workClient = await createWorkClient(databaseUrl, pool);
    const kernel = createKernel({
      pool,
      routeKey: system.routeKey,
      tokens: system.tokenKeys,
      workClient,
      requestDeadlineMs: TEST_REQUEST_DEADLINE_MS,
      clock: () => new Date(fixtureTime),
      content: { cursorNow: () => fixtureTime },
      access: () => system.access,
      writeRate: createWriteRateLimiter({ secret: crypto.randomUUID() + crypto.randomUUID(), overrides: highRates }),
      ratePeer: () => '127.0.0.1',
      ...(search
        ? {
            search: createSearchService({
              pool,
              client: search,
              prefix,
              source: searchSubjects,
              ratings: publicRatings,
              cursors: system.tokenKeys,
            }),
          }
        : {}),
    });
    let fixture: Fixture | undefined;
    let schemeId: string;
    const grants = new Map<
      string,
      {
        resource: { route: number; id: string };
        subject: { kind: 'account'; id: string };
        actions: string[];
        valid: string;
      }
    >();
    const reader: Persona = { id: system.actors.author.actor.accountId, bearer: system.actors.author.bearer };
    const outsider: Persona = { id: system.actors.other.actor.accountId, bearer: system.actors.other.bearer };
    const labels = new Map<string, string>();

    async function send(
      method: string,
      path: string,
      actor: Persona | null,
      body?: unknown,
      key?: string,
      extra?: Record<string, string>,
    ) {
      return kernel.handle(
        new Request(`${audience}${path}`, {
          method,
          headers: {
            ...(actor ? { authorization: `Bearer ${actor.bearer}` } : {}),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(key === undefined ? {} : { 'idempotency-key': key }),
            ...extra,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    }
    async function result<T>(response: Response, map: (json: any) => T): Promise<ApiResult<T>> {
      return { response, value: response.ok ? map(await response.clone().json()) : null };
    }
    async function setup<T>(
      method: string,
      path: string,
      body?: unknown,
      actor = moderator,
      extra?: Record<string, string>,
    ): Promise<T> {
      const response = await send(method, path, actor, body, JSON.stringify(crypto.randomUUID()), extra);
      if (!response.ok)
        throw new Error(`Fixture ${method} ${path}: ${response.status} ${await response.clone().text()}`);
      return response.json() as Promise<T>;
    }
    async function grant(id: string, subject: Persona, actions: string[]) {
      await seedGovernanceAuthority(pool, route(id), id, moderator.id, ['access:grant', ...actions]);
      const input = {
        resource: { route: route(id), id },
        subject: { kind: 'account' as const, id: subject.id },
        actions,
        valid: '(,)',
      };
      await setup('POST', '/v1/grants', input);
      return input;
    }
    async function subject(
      label: string,
      type = 'schema:Book',
      statements?: unknown,
      actor = moderator,
    ): Promise<string> {
      const { subject: created } = await setup<{ subject: { id: string } }>(
        'POST',
        '/v1/subjects',
        {
          type,
          labels: { en: label },
          ...(statements ? { statements } : {}),
        },
        actor,
      );
      labels.set(created.id, label);
      return created.id;
    }
    async function boardGrants(id: string, visibility: string) {
      await seedGovernanceAuthority(pool, route(id), id, moderator.id, [
        'access:grant',
        'board:read',
        'thread:create',
        'moderation:takedown',
      ]);
      if (visibility === 'protected') grants.set(id, await grant(id, reader, ['board:read']));
      await grant(id, reader, ['thread:create']);
    }
    async function effects(mode: 'drain' | 'replay') {
      if (mode === 'replay') {
        // Reset only delivery checkpoints; durable effect identities and native receipts deduplicate replay.
        await worker?.stop();
        worker = undefined;
        await pool.query("DELETE FROM core.consumer_checkpoint WHERE consumer = 'effects'");
      }
      worker ??= await startUserCasesWorker(system, prefix);
      await settleUserCasesWorker(system, worker, prefix);
      fixtureTime = Math.max(fixtureTime, Date.now());
      if (search) await search.request('POST', `/${prefix}subjects-g1/_refresh`);
    }
    async function contentResult<T>(response: Response, field: 'thread' | 'post'): Promise<ApiResult<T>> {
      return result(response, (json) => json[field] as T);
    }
    const driver: ContentUserCasesDriver = {
      close,
      async provision() {
        if (fixture) return fixture;
        const voters = [reader];
        for (const _name of data.personas.voters.slice(1)) voters.push(await person(system));
        const priorVoters: Persona[] = [];
        for (const _name of data.personas.priorVoters) priorVoters.push(await person(system));
        const privateVoters: Persona[] = [];
        for (const _name of data.personas.privateVoters) privateVoters.push(await person(system));
        const unpublishedVoter = await person(system);
        const { digest } = await setup<{ digest: string }>('POST', '/v1/definitions/releases', {
          release: bundledRelease,
        });
        await setup('POST', `/v1/definitions/releases/${digest}:activate`, { expected_head: null });
        await setup('POST', '/v1/platform/exposure/personal_library:open');
        const subjectId = await subject(data.subjects.subject);
        const otherSubjectId = await subject(data.subjects.otherSubject);
        const belowThresholdSubjectId = await subject(data.subjects.belowThresholdSubject);
        const priorSubjectIds: string[] = [];
        for (const label of data.subjects.priorSubjects) priorSubjectIds.push(await subject(label));
        const { space } = await setup<{ space: { spaceId: string } }>(
          'POST',
          '/v1/spaces',
          { title: 'Controlled private Realm host' },
          reader,
        );
        const { realm } = await setup<{ realm: { realmId: string; headRevisionId: string } }>(
          'POST',
          '/v1/realms',
          {
            spaceId: space.spaceId,
            title: data.rating.privateRealm,
            visibility: 'protected',
            contextId: GLOBAL_CONTEXT,
          },
          reader,
        );
        schemeId = await subject('Controlled board scheme', 'skos:ConceptScheme', undefined, reader);
        await setup('PUT', `/v1/realms/${realm.realmId}/boardScheme`, { schemeId }, reader, {
          'if-match': JSON.stringify(realm.headRevisionId),
        });
        await setup(
          'POST',
          '/v1/roleGrants',
          {
            resource: { route: route(realm.realmId), id: realm.realmId },
            subject: { kind: 'account', id: moderator.id },
            role: 'community.realm.owner',
            valid: '(,)',
          },
          reader,
        );
        await setup('POST', `/v1/realms/${realm.realmId}/members`, { accountId: reader.id });
        const reviewBoards: string[] = [];
        for (const visibility of ['published', 'protected'] as const) {
          // The Global board is independently routed from every review author.
          let conceptId: string;
          do {
            conceptId = await subject(`Controlled ${visibility} reviews concept`, 'skos:Concept');
          } while (
            [...voters, outsider, moderator].some(
              (actor) => partitionOf(route(actor.id)) === partitionOf(route(conceptId)),
            )
          );
          await seedGovernanceAuthority(pool, 0, GLOBAL_CONTEXT, moderator.id, ['board:create']);
          const { board } = await setup<{ board: { id: string } }>('POST', '/v1/boards', {
            conceptId,
            title: `Controlled ${visibility} reviews`,
            purpose: 'reviews',
            visibility,
          });
          await boardGrants(board.id, visibility);
          reviewBoards.push(board.id);
        }
        fixture = {
          reader,
          outsider,
          moderator,
          voters,
          priorVoters,
          privateVoters,
          unpublishedVoter,
          subjectId,
          otherSubjectId,
          belowThresholdSubjectId,
          priorSubjectIds,
          standardQuestionId: STANDARD_QUESTION_ID,
          globalPopulationId: GLOBAL_CONTEXT,
          globalContextId: GLOBAL_CONTEXT,
          privateRealmId: realm.realmId,
          publicReviewsBoardId: reviewBoards[0]!,
          protectedReviewsBoardId: reviewBoards[1]!,
        };
        await effects('drain');
        return fixture;
      },
      async putVote(subjectId, questionId, units, options) {
        return result(
          await send(
            'PUT',
            `/v1/subjects/${subjectId}/ratings/${questionId}/vote`,
            options.actor,
            { units },
            options.key,
          ),
          (json) => json,
        );
      },
      async ownVote(subjectId, questionId, actor) {
        return result(await send('GET', `/v1/subjects/${subjectId}/ratings/${questionId}/vote`, actor), (json) => json);
      },
      async createThread(input, options) {
        const response = await send('POST', '/v1/threads', options.actor, contentInput(input), options.key);
        const value = await contentResult<Thread>(response, 'thread');
        if (value.value)
          await seedGovernanceAuthority(pool, route(value.value.firstPost.id), value.value.firstPost.id, moderator.id, [
            'moderation:takedown',
          ]);
        return value;
      },
      async createPost({ threadId, ...input }, options) {
        return contentResult<Post>(
          await send('POST', `/v1/threads/${threadId}/posts`, options.actor, contentInput(input), options.key),
          'post',
        );
      },
      async revise(post, input, options) {
        return contentResult<Post>(
          await send('POST', `/v1/posts/${post.id}/revisions`, options.actor, contentInput(input), options.key, {
            'if-match': JSON.stringify(post.revisionId),
          }),
          'post',
        );
      },
      async readRevision(postId, revisionId, actor) {
        return contentResult<Post>(await send('GET', `/v1/posts/${postId}/revisions/${revisionId}`, actor), 'post');
      },
      async readPost(postId, actor) {
        return contentResult<Post>(await send('GET', `/v1/posts/${postId}`, actor), 'post');
      },
      async subjectReviews(subjectId, placeId, query) {
        const params = new URLSearchParams({
          place: placeId,
          kind: 'review',
          limit: String(query.limit),
          ...(query.cursor ? { cursor: query.cursor } : {}),
        });
        return result(await send('GET', `/v1/subjects/${subjectId}/threads?${params}`, null), (json) =>
          page<Thread>(json),
        );
      },
      async subjectFigure(subjectId, actor) {
        return result(await send('GET', `/v1/subjects/${subjectId}/figure`, actor), (json) => figure(json.figure));
      },
      async searchCard(subjectId, actor) {
        const response = await send('POST', '/v1/subjects:search', actor, { text: labels.get(subjectId), limit: 100 });
        return result(response, (json) => {
          const hit = (json.subjects as { id: string; figure?: PublicFigureView }[]).find(
            (candidate) => candidate.id === subjectId,
          );
          if (!hit) throw new Error(`Native subject.search omitted ${subjectId}: ${JSON.stringify(json)}`);
          // A missing producer field remains absent; the frozen suite observes the missing capability.
          return { subjectId: hit.id, ...(hit.figure === undefined ? {} : { figure: figure(hit.figure) }) } as {
            subjectId: string;
            figure: Figure;
          };
        });
      },
      async realmFigure(subjectId, realmId, actor) {
        return result(
          await send(
            'GET',
            `/v1/subjects/${subjectId}/ratings?question=${STANDARD_QUESTION_ID}&population=${realmId}`,
            actor,
          ),
          (json) => json.figures[0] as RealmFigure,
        );
      },
      async joinPrivateRealm(member, options) {
        return result(
          await send(
            'POST',
            `/v1/realms/${fixture!.privateRealmId}/members`,
            options.actor,
            { accountId: member.id },
            options.key,
          ),
          (json) => json,
        );
      },
      async suspend(account, options) {
        return result(
          await send(
            'POST',
            `/v1/accounts/${account.id}:suspend`,
            options.actor,
            { reason: 'Controlled ineligible voter' },
            options.key,
          ),
          (json) => json,
        );
      },
      async createBoard(visibility, options) {
        const conceptId = await subject(
          `Controlled ${visibility} discussion concept ${crypto.randomUUID()}`,
          'skos:Concept',
          {
            'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: schemeId } }],
          },
          options.actor,
        );
        const response = await send(
          'POST',
          `/v1/realms/${fixture!.privateRealmId}/boards`,
          options.actor,
          {
            conceptId,
            title: 'Controlled discussion board',
            purpose: 'discussion',
            visibility,
          },
          options.key,
        );
        const value = await result<{ id: string }>(response, (json) => json.board);
        if (value.value) await boardGrants(value.value.id, visibility);
        return value;
      },
      async takedown(target, options) {
        return result(
          await send(
            'POST',
            `/v1/${target.kind === 'board' ? 'boards' : 'posts'}/${target.id}:takeDown`,
            options.actor,
            { reason: 'Controlled late takedown' },
            options.key,
          ),
          (json) => json,
        );
      },
      async revokeBoardRead(boardId, _reader, options) {
        const input = grants.get(boardId);
        if (!input) throw new Error('Fixture board read grant is missing');
        if (input.subject.id !== _reader.id) throw new Error('Fixture board grant belongs to another reader');
        return result(await send('POST', '/v1/grants:revoke', options.actor, input, options.key), (json) => json);
      },
      async page(request) {
        const params = new URLSearchParams({
          limit: String(request.limit),
          ...(request.cursor ? { cursor: request.cursor } : {}),
        });
        if (request.kind === 'board') params.set('sort', request.sort);
        const path =
          request.kind === 'board' ? `/v1/boards/${request.boardId}/threads` : `/v1/threads/${request.threadId}/posts`;
        return result(await send('GET', `${path}?${params}`, request.actor), (json) => page<{ id: string }>(json));
      },
      async holdPage(request: PageRequest) {
        // Board candidates are read before the parent decision; content.thread
        // is first read after it. Post-page reaction enrichment follows the
        // root and entry checks. pg_stat_activity confirms this request reached
        // its later read before a mutation can run. No query hook or result
        // modification participates in the barrier.
        const table = request.kind === 'board' ? 'content.thread' : 'content.reaction_total';
        const lock = await pool.connect();
        let released = false;
        let held: HeldPage;
        let releasePromise: Promise<void> | undefined;
        try {
          await lock.query('BEGIN');
          await lock.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
          const {
            rows: [owner],
          } = await lock.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
          const requestStartedAt = Date.now();
          const response = driver.page(request);
          void response.catch(() => {});
          let finished = false;
          void response.then(
            () => {
              finished = true;
            },
            () => {
              finished = true;
            },
          );
          const reached = (async () => {
            const deadline = Date.now() + 10_000;
            for (;;) {
              const waiting = await pool.query(
                `
                SELECT 1 FROM pg_stat_activity
                WHERE datname=current_database() AND wait_event_type='Lock'
                  AND $1::integer=ANY(pg_blocking_pids(pid))
                  AND query_start >= to_timestamp($2::double precision / 1000)
                  AND position($3::text in query) > 0 LIMIT 1`,
                [owner!.pid, requestStartedAt, table],
              );
              if (waiting.rowCount) return;
              if (released || finished) throw new Error('Page finished before the post-authorization lock barrier');
              if (Date.now() >= deadline) throw new Error(`Page never reached its post-authorization ${table} lock`);
            }
          })();
          void reached.catch(() => {});
          held = {
            reached,
            response,
            release: () =>
              (releasePromise ??= (async () => {
                released = true;
                try {
                  await lock.query('ROLLBACK');
                } finally {
                  lock.release();
                }
                try {
                  await response;
                } finally {
                  holds.delete(held);
                }
              })()),
          };
          holds.add(held);
          return held;
        } catch (error) {
          try {
            await lock.query('ROLLBACK');
          } finally {
            lock.release();
          }
          throw error;
        }
      },
      effects,
    };
    return driver;
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'User cases construction failed');
    }
    throw error;
  }
}
