import { expect } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import type { Account, Method, Realm } from '../../../../../specs/community-driver.ts';
import { PLATFORM_RESOURCE } from '../../../src/access/bootstrap-governance.ts';
import { newId, routeOf } from '../../../src/route/route.ts';
import {
  closeCommunityDrivers,
  createCommunityDriver,
  queryCommunityDatabase,
  restartWorker,
  waitCommunityWorkflow,
  worker,
} from '../../community/community-driver.ts';

type Post = { id: string; revisionId: string; body: unknown };
type Thread = { id: string; firstPost: Post };
export type Target = {
  kind: 'thread' | 'post';
  id: string;
  threadId: string;
  postId: string;
  revisionId: string;
  text: string;
};
export const evidence = 'Submitted Realm moderation evidence';
export const reason = 'Realm moderation decision statement';
export const appealStatement = 'Author requests independent review';

/** Private persona setup over the unchanged native Community composition. */
export async function moderationRealmFixture() {
  const driver = await createCommunityDriver();
  let paused = false;
  async function close() {
    await closeCommunityDrivers();
  }
  try {
    const personas = await driver.provision();
    const { owner, member, moderator, outsider, subjectOwner: platform } = personas;
    async function call<T = Record<string, unknown>>(
      actor: Account,
      method: Method,
      path: string,
      body?: unknown,
      key: string = crypto.randomUUID(),
      ifMatch?: string,
    ) {
      const response = await driver.request({
        actor,
        method,
        path,
        ...(body === undefined ? {} : { body }),
        ...(method === 'GET' ? {} : { key: JSON.stringify(key) }),
        ...(ifMatch === undefined ? {} : { ifMatch }),
      });
      const text = await response.text();
      return { response, text, value: (text ? JSON.parse(text) : null) as T };
    }
    async function checked<T = Record<string, unknown>>(
      actor: Account,
      method: Method,
      path: string,
      body?: unknown,
      status = 200,
      key?: string,
      ifMatch?: string,
    ): Promise<T> {
      const result = await call<T>(actor, method, path, body, key, ifMatch);
      expect({ status: result.response.status, body: result.value }, `${method} ${path} as ${actor.id}`).toMatchObject({
        status,
      });
      return result.value;
    }
    async function grant(actor: Account, id: string, actions: string[]) {
      await checked(
        platform,
        'POST',
        '/v1/grants',
        {
          resource: { route: routeOf(id), id },
          subject: { kind: 'account', id: actor.id },
          actions,
          valid: '(,)',
        },
        201,
      );
    }
    const { space } = await checked<{ space: { spaceId: string } }>(
      owner,
      'POST',
      '/v1/spaces',
      {
        title: 'Moderation boundary Space',
      },
      201,
    );
    let { realm } = await checked<{ realm: Realm }>(
      owner,
      'POST',
      '/v1/realms',
      {
        spaceId: space.spaceId,
        title: 'Protected moderation Realm',
        visibility: 'protected',
        contextId: personas.contextId,
      },
      201,
    );
    const { subject: scheme } = await checked<{ subject: { id: string } }>(
      owner,
      'POST',
      '/v1/subjects',
      {
        type: 'skos:ConceptScheme',
        labels: { en: 'Moderation board scheme' },
      },
      201,
    );
    ({ realm } = await checked<{ realm: Realm }>(
      owner,
      'PUT',
      `/v1/realms/${realm.realmId}/boardScheme`,
      {
        schemeId: scheme.id,
      },
      200,
      undefined,
      JSON.stringify(realm.headRevisionId),
    ));
    const { subject: concept } = await checked<{ subject: { id: string } }>(
      owner,
      'POST',
      '/v1/subjects',
      {
        type: 'skos:Concept',
        labels: { en: 'Moderation board concept' },
        statements: {
          'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.id } }],
        },
      },
      201,
    );
    const { board } = await checked<{ board: { id: string } }>(
      owner,
      'POST',
      `/v1/realms/${realm.realmId}/boards`,
      { conceptId: concept.id, title: 'Moderation boundary board', visibility: 'published' },
      201,
    );
    for (const actor of [member, moderator]) {
      await checked(owner, 'POST', `/v1/realms/${realm.realmId}/members`, { accountId: actor.id }, 202);
    }
    await driver.settle();
    expect((await driver.grantModerator(realm.realmId, moderator)).status).toBe(201);
    // Keep a real independent read grant: the ban must override it while removal is pending and after it.
    await grant(member, realm.realmId, ['realm:read']);
    await grant(moderator, board.id, ['moderation:read_reports']);
    await grant(platform, PLATFORM_RESOURCE.id, ['moderation:read_reports', 'moderation:takedown']);

    async function target(kind: Target['kind'], label: string): Promise<Target> {
      const text = `${label} private target body`;
      const { thread } = await checked<{ thread: Thread }>(
        member,
        'POST',
        '/v1/threads',
        {
          boardId: board.id,
          title: label,
          body: fromPlainText(text),
          licence: 'MIT',
          subjectIds: [],
          visibility: 'published',
        },
        201,
      );
      const post =
        kind === 'thread'
          ? thread.firstPost
          : (
              await checked<{ post: Post }>(
                member,
                'POST',
                `/v1/threads/${thread.id}/posts`,
                { body: fromPlainText(text), licence: 'MIT', parentId: thread.firstPost.id },
                201,
              )
            ).post;
      const id = kind === 'thread' ? thread.id : post.id;
      for (const scope of new Set([thread.id, id])) await grant(moderator, scope, ['moderation:read_reports']);
      return { kind, id, threadId: thread.id, postId: post.id, revisionId: post.revisionId, text };
    }
    const reportBody = (target: Target) => ({
      target: { kind: target.kind, id: target.id },
      revisionId: target.revisionId,
      reason: 'spam',
      evidence,
    });
    async function report(target: Target, actor: Account, key: string = crypto.randomUUID()) {
      const value = await checked<{ reportId: string }>(actor, 'POST', '/v1/reports', reportBody(target), 201, key);
      return { id: value.reportId, key };
    }
    async function takeDown(target: Target) {
      const path = `/v1/${target.kind}s/${target.id}:takeDown`;
      const key = crypto.randomUUID();
      const value = await checked(moderator, 'POST', path, { reason }, 200, key);
      expect(await checked(moderator, 'POST', path, { reason }, 200, key)).toEqual(value);
      await driver.settle();
      const inbox = await checked<{
        items: { kind: string; threadId: string | null; postId: string | null; decisionId: string | null }[];
      }>(member, 'GET', `/v1/accounts/${member.id}/notifications?limit=50`);
      const notice = inbox.items.find(
        (row) =>
          row.kind === 'moderation_decision' &&
          row.threadId === target.threadId &&
          row.postId === (target.kind === 'post' ? target.id : null) &&
          row.decisionId,
      );
      expect(notice?.decisionId).toEqual(expect.any(String));
      return notice!.decisionId!;
    }
    async function ban() {
      await driver.settle();
      await worker.stop();
      paused = true;
      const path = `/v1/realms/${realm.realmId}/bans/${member.id}`;
      const key = crypto.randomUUID();
      const body = { reason: 'Native moderation persona ban' };
      const value = await checked<{ ban: { workflowId: string | null } }>(owner, 'PUT', path, body, 200, key);
      expect(value.ban.workflowId).toEqual(expect.any(String));
      expect(await checked(owner, 'PUT', path, body, 200, key)).toEqual(value);
      // Observation corroborates that immediate denial precedes publication; it does not perform removal.
      expect(
        await queryCommunityDatabase(
          'SELECT role FROM community.realm_member WHERE realm_id=$1 AND account_id=$2 AND upper_inf(valid)',
          [realm.realmId, member.id],
        ),
      ).toEqual([{ role: 'member' }]);
      return value.ban.workflowId!;
    }
    async function completeBan(workflowId: string) {
      await restartWorker();
      paused = false;
      await waitCommunityWorkflow(workflowId);
      await driver.settle();
      expect(
        await queryCommunityDatabase(
          'SELECT role FROM community.realm_member WHERE realm_id=$1 AND account_id=$2 AND upper_inf(valid)',
          [realm.realmId, member.id],
        ),
      ).toEqual([]);
    }
    return {
      member,
      moderator,
      outsider,
      platform,
      realm,
      board,
      call,
      checked,
      target,
      report,
      reportBody,
      takeDown,
      ban,
      completeBan,
      settle: () => driver.settle(),
      missing: (id: string) => newId(routeOf(id)!),
      async close() {
        try {
          if (paused) {
            await restartWorker();
            paused = false;
            await driver.settle();
          }
        } finally {
          await close();
        }
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export type ModerationRealmFixture = Awaited<ReturnType<typeof moderationRealmFixture>>;
