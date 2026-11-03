import { withDocumentIds, type DocumentNode } from '@rezics/document';
import type {
  ApiResult,
  Appeal,
  ContentNotificationDriver,
  Decision,
  Fixture,
  Inbox,
  Notice,
  NoticeKind,
  Persona,
  Post,
  Report,
  Thread,
} from '../../../../specs/content-notification-driver.ts';
import { createNotificationEffectHost } from './support/notification-effect-host.ts';
import { createNotificationFixture } from './support/notification-fixtures.ts';
import type { GrowthDatabase } from '../support/growth.ts';

const AUDIENCE = 'https://content.test';
type Raw = Record<string, unknown>;

function object(value: unknown, label: string): Raw {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError(`${label} response is not an object`);
  return value as Raw;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} response field is not a string`);
  return value;
}

function resultMap<T>(value: ApiResult<unknown>, map: (body: unknown) => T): ApiResult<T> {
  return { response: value.response, value: value.value === null ? null : map(value.value) };
}

function notificationTarget(value: Raw): Notice['target'] {
  const target: Notice['target'] = {};
  for (const key of ['threadId', 'postId', 'decisionId', 'reportId'] as const) {
    const id = value[key];
    if (id !== null && id !== undefined) target[key] = string(id, `notification.${key}`);
  }
  return target;
}

function decisionOf(value: unknown): Decision {
  const raw = object(value, 'Moderation decision');
  const targetKind = string(raw.targetKind, 'decision.targetKind');
  if (targetKind !== 'thread' && targetKind !== 'post') throw new TypeError('Decision target kind is invalid');
  return {
    id: string(raw.id, 'decision.id'),
    target: { kind: targetKind, id: string(raw.targetId, 'decision.targetId') },
    action:
      raw.action === 'takedown'
        ? 'takedown'
        : (() => {
            throw new TypeError('Decision action is invalid');
          })(),
    statement: string(raw.statement, 'decision.statement'),
    createdAt: string(raw.decidedAt, 'decision.decidedAt'),
    appealDeadline: string(raw.appealDeadline, 'decision.appealDeadline'),
  };
}

function postOf(value: unknown): Post {
  const raw = object(value, 'Post');
  return {
    id: string(raw.id, 'post.id'),
    threadId: string(raw.threadId, 'post.threadId'),
  };
}

function threadOf(value: unknown): Thread {
  const raw = object(value, 'Thread');
  return { id: string(raw.id, 'thread.id'), firstPost: postOf(raw.firstPost) };
}

function noticeOf(value: unknown): Notice {
  const raw = object(value, 'Notification');
  const kind = string(raw.kind, 'notification.kind');
  if (!['reply', 'mention', 'moderation_decision'].includes(kind)) throw new TypeError('Notification kind is invalid');
  const actorId = raw.actorId;
  if (actorId !== null && typeof actorId !== 'string') throw new TypeError('Notification actorId is invalid');
  if (typeof raw.unread !== 'boolean') throw new TypeError('Notification unread flag is invalid');
  return {
    id: string(raw.id, 'notification.id'),
    kind: kind as NoticeKind,
    createdAt: string(raw.createdAt, 'notification.createdAt'),
    actorId,
    target: notificationTarget(raw),
    unread: raw.unread,
  };
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return string(value, label);
}

function documentOf(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const snapshot = value as Record<string, unknown>;
  const doc = snapshot.doc;
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return value;
  const root = doc as Record<string, unknown>;
  if (root.type !== 'doc' || !Array.isArray(root.content)) return value;
  return { ...snapshot, doc: withDocumentIds(doc as DocumentNode) };
}

export type ContentNotificationGrowthDriver = ContentNotificationDriver & { growthDatabase: GrowthDatabase };

export async function createContentNotificationDriver(): Promise<ContentNotificationDriver> {
  return (await buildContentNotificationDriver(false)).driver;
}

export async function createContentNotificationGrowthDriver(): Promise<ContentNotificationGrowthDriver> {
  const { driver, growthDatabase } = await buildContentNotificationDriver(true);
  if (!growthDatabase) {
    await driver.close();
    throw new Error('Notification growth fixture did not open its instrumented database');
  }
  return Object.assign(driver, { growthDatabase });
}

async function buildContentNotificationDriver(growth: boolean): Promise<{
  driver: ContentNotificationDriver;
  growthDatabase?: GrowthDatabase;
}> {
  const setup = await createNotificationFixture({ growth });
  const { system, fixture } = setup;
  let effectHost: Awaited<ReturnType<typeof createNotificationEffectHost>> | undefined;
  if (!growth) {
    try {
      effectHost = await createNotificationEffectHost(setup.appDatabaseUrl, setup.workClock);
    } catch (error) {
      await setup.close();
      throw error;
    }
  }
  const threadIds: string[] = [];
  let fixtureValue: Fixture | undefined;
  let closed = false;

  async function request(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    actor: Persona,
    body?: unknown,
    structuredKey?: string,
    headers: Record<string, string> = {},
  ): Promise<ApiResult<unknown>> {
    const response = await system.kernel.handle(
      new Request(`${AUDIENCE}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${actor.bearer}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(structuredKey === undefined ? {} : { 'idempotency-key': structuredKey }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    let value: unknown = null;
    if (response.ok && response.status !== 204) value = await response.clone().json();
    return { response, value };
  }

  function remember(id: string): void {
    setup.remember(id);
  }

  async function pendingAppealRows(actor: Persona): Promise<ApiResult<Raw[]>> {
    const id = threadIds.at(-1);
    if (!id) throw new Error('No thread has been created for the appeals queue');
    const result = await request('GET', `/v1/threads/${id}/appeals`, actor);
    return resultMap(result, (body) => {
      const raw = object(body, 'Appeals queue');
      if (!Array.isArray(raw.appeals)) throw new TypeError('Appeals queue is missing appeals');
      return raw.appeals.map((entry) => object(entry, 'Pending appeal'));
    });
  }

  async function appealFromApi(queued: Raw, actor: Persona): Promise<Appeal> {
    const id = string(queued.id, 'appeal.id');
    const decisionId = string(queued.decisionId, 'appeal.decisionId');
    const decisionResult = await request('GET', `/v1/moderation-decisions/${decisionId}`, actor);
    if (!decisionResult.value) throw new Error(`Appeal decision read failed (${decisionResult.response.status})`);
    const decision = object(decisionResult.value, 'Appeal decision');
    const state = object(decision.appeal, 'Appeal decision state');
    if (string(state.id, 'appeal state.id') !== id) throw new Error('Appeal decision returned a different appeal');
    const wireOutcome = state.outcome;
    const outcome: Appeal['outcome'] =
      wireOutcome === null
        ? 'pending'
        : wireOutcome === 'upheld'
          ? 'uphold'
          : wireOutcome === 'reversed'
            ? 'reverse'
            : (() => {
                throw new TypeError('Appeal outcome is invalid');
              })();
    return {
      id,
      decisionId,
      appellantId: string(queued.appellantId, 'appeal.appellantId'),
      statement: string(queued.statement, 'appeal.statement'),
      outcome,
      resolutionStatement: nullableString(state.statement, 'appeal.resolutionStatement'),
    };
  }

  const driver: ContentNotificationDriver = {
    async close() {
      if (closed) return;
      closed = true;
      try {
        await effectHost?.close();
      } finally {
        await setup.close();
      }
    },
    async provision() {
      if (fixtureValue) return fixtureValue;
      fixtureValue = fixture;
      setup.remember(fixture.publicBoardId);
      setup.remember(fixture.protectedBoardId);
      return fixtureValue;
    },
    async createThread(input, options) {
      const result = await request(
        'POST',
        '/v1/threads',
        options.actor,
        {
          title: 'Notification test thread',
          body: documentOf(input.body),
          licence: 'MIT',
          subjectIds: [],
          boardId: input.boardId,
          visibility: input.visibility,
        },
        options.key,
      );
      const mapped = resultMap(result, (body) => {
        const thread = threadOf(object(body, 'Thread create').thread);
        threadIds.push(thread.id);
        remember(thread.id);
        remember(thread.firstPost.id);
        return thread;
      });
      if (mapped.value) {
        if (growth) {
          await setup.grantModerationTarget(mapped.value.id);
          await setup.grantModerationTarget(mapped.value.firstPost.id, mapped.value.id);
          await setup.grantReportTarget(mapped.value.id, fixture.reporter.id);
          await setup.grantReportTarget(mapped.value.firstPost.id, fixture.reporter.id);
        }
        for (const account of [fixture.author, fixture.replier, fixture.mentioned])
          await setup.grantPostTarget(mapped.value.id, account.id);
      }
      return mapped;
    },
    async createPost(input, options) {
      const result = await request(
        'POST',
        `/v1/threads/${input.threadId}/posts`,
        options.actor,
        {
          body: documentOf(input.body),
          licence: 'MIT',
          ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
        },
        options.key,
      );
      const mapped = resultMap(result, (body) => {
        const post = postOf(object(body, 'Post create').post);
        remember(post.id);
        return post;
      });
      if (mapped.value) {
        if (growth) {
          await setup.grantModerationTarget(mapped.value.id, input.threadId);
          await setup.grantReportTarget(mapped.value.id, fixture.reporter.id);
        }
      }
      return mapped;
    },
    async revise(input, options) {
      const result = await request(
        'POST',
        `/v1/posts/${input.post.id}/revisions`,
        options.actor,
        {
          body: documentOf(input.body),
          licence: 'MIT',
        },
        options.key,
      );
      const mapped = resultMap(result, (body) => {
        const post = postOf(object(body, 'Post revision').post);
        remember(post.id);
        return post;
      });
      return mapped;
    },
    async readPost(post, actor) {
      const result = await request('GET', `/v1/posts/${post.id}`, actor);
      return resultMap(result, (body) => postOf(object(body, 'Post read').post));
    },
    async readTarget(target, actor) {
      const result =
        target.kind === 'thread'
          ? await request('GET', `/v1/threads/${target.id}`, actor)
          : await request('GET', `/v1/posts/${target.id}`, actor);
      return resultMap(result, (body) => {
        const raw = object(body, 'Target read');
        const item = target.kind === 'thread' ? object(raw.thread, 'Thread read') : object(raw.post, 'Post read');
        return {
          id: string(item.id, 'target.id'),
          securityRevision: string(item.securityRevision, 'target.securityRevision'),
        };
      });
    },
    async inbox(accountId, actor, query) {
      const params = new URLSearchParams();
      if (query?.limit !== undefined) params.set('limit', String(query.limit));
      if (query?.cursor !== undefined) params.set('cursor', query.cursor);
      const suffix = params.size > 0 ? `?${params.toString()}` : '';
      const result = await request('GET', `/v1/accounts/${accountId}/notifications${suffix}`, actor);
      return resultMap(result, (body) => {
        const raw = object(body, 'Inbox');
        if (!Array.isArray(raw.items)) throw new TypeError('Inbox items are missing');
        return {
          items: raw.items.map(noticeOf),
          next: nullableString(raw.next, 'inbox.next'),
        } satisfies Inbox;
      });
    },
    async unread(accountId, actor) {
      const result = await request('GET', `/v1/accounts/${accountId}/notifications/count`, actor);
      return resultMap(result, (body) => {
        const raw = object(body, 'Unread count');
        if (typeof raw.count !== 'number' || typeof raw.capped !== 'boolean')
          throw new TypeError('Unread count response is invalid');
        return { count: raw.count, capped: raw.capped };
      });
    },
    async markSeen(accountId, noticeId, options) {
      return request(
        'POST',
        `/v1/accounts/${accountId}/notifications:markSeen`,
        options.actor,
        { through: noticeId },
        options.key,
      );
    },
    async takedown(target, reason, options) {
      if (!growth) await setup.grantModerationTarget(target.id);
      const result = await request(
        'POST',
        `/v1/${target.kind === 'thread' ? 'threads' : 'posts'}/${target.id}:takeDown`,
        options.actor,
        { reason },
        options.key,
      );
      return resultMap(result, (body) => {
        const raw = object(body, 'Takedown');
        return { securityRevision: string(raw.securityRevision, 'takedown.securityRevision') };
      });
    },
    async decision(id, actor) {
      const result = await request('GET', `/v1/moderation-decisions/${id}`, actor);
      return resultMap(result, decisionOf);
    },
    async report(target, options) {
      if (!growth) {
        await setup.grantModerationTarget(target.id);
        await setup.grantReportTarget(target.id, options.actor.id);
      }
      const result = await request('POST', '/v1/reports', options.actor, { target, reason: 'spam' }, options.key);
      const mapped = resultMap(result, (body) => ({
        reportId: string(object(body, 'Report create').reportId, 'reportId'),
      }));
      if (mapped.value) remember(mapped.value.reportId);
      return mapped;
    },
    async readReport(id, actor) {
      const result = await request('GET', `/v1/reports/${id}`, actor);
      return resultMap(result, (body) => {
        const report = object(object(body, 'Report read').report, 'Report');
        const outcome = report.outcome === null ? 'open' : string(report.outcome, 'report.outcome');
        if (outcome !== 'open' && outcome !== 'actioned' && outcome !== 'dismissed')
          throw new TypeError('Report outcome is invalid');
        return { id: string(report.id, 'report.id'), outcome } satisfies Report;
      });
    },
    async dismissReport(id, _statement, options) {
      return request('POST', `/v1/reports/${id}:dismiss`, options.actor, undefined, options.key);
    },
    async appeal(decisionId, statement, options) {
      const result = await request(
        'POST',
        `/v1/moderation-decisions/${decisionId}:appeal`,
        options.actor,
        { statement },
        options.key,
      );
      const mapped = resultMap(
        result,
        (body) => ({ id: string(object(body, 'Appeal create').id, 'appeal.id') }) as Appeal,
      );
      if (!mapped.value) return mapped;
      remember(mapped.value.id);
      const queued = await pendingAppealRows(fixture.secondModerator);
      const row = queued.value?.find((item) => item.id === mapped.value!.id);
      if (!row) throw new Error('Created appeal is missing from the moderator queue');
      return { response: result.response, value: await appealFromApi(row, options.actor) };
    },
    async resolveAppeal(id, outcome, statement, options) {
      const queued = await pendingAppealRows(fixture.secondModerator);
      const row = queued.value?.find((item) => item.id === id);
      const result = await request(
        'POST',
        `/v1/moderation-appeals/${id}:resolve`,
        options.actor,
        { outcome, statement },
        options.key,
      );
      const mapped = resultMap(
        result,
        (body) => ({ id: string(object(body, 'Appeal resolution').id, 'appeal.id') }) as Appeal,
      );
      if (!mapped.value) return mapped;
      if (!row) throw new Error('Resolved appeal is missing from the moderator queue');
      return { response: result.response, value: await appealFromApi(row, fixture.author) };
    },
    async pendingAppeals(actor) {
      const result = await pendingAppealRows(actor);
      if (!result.value) return { response: result.response, value: null };
      const appeals = await Promise.all(result.value.map((queued) => appealFromApi(queued, actor)));
      return { response: result.response, value: appeals };
    },
    async effects(mode) {
      if (!effectHost) throw new Error('Notification effect host is unavailable in a growth fixture');
      const consumer =
        mode === 'drain' ? 'notification_drain' : `notification_replay_${crypto.randomUUID().replaceAll('-', '')}`;
      await effectHost.deliver(consumer, [...setup.contentPartitions]);
    },
    fixtures: {
      async notificationAllowed(account: Persona, kind: NoticeKind, allowed: boolean) {
        await setup.setPreference(account, kind, allowed);
      },
      async realmMember(account: Persona, member: boolean) {
        await setup.realmMember(account, member);
      },
      async accountState(account: Persona, state: 'active' | 'deleted') {
        await setup.setAccountState(account, state);
      },
      async now(instant: string) {
        await setup.setNow(instant);
      },
    },
  };
  return { driver, ...(setup.growthDatabase ? { growthDatabase: setup.growthDatabase } : {}) };
}
