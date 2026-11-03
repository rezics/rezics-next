import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Account } from '../../../../specs/community-driver.ts';
import {
  appealStatement,
  evidence,
  moderationRealmFixture,
  reason,
  type ModerationRealmFixture,
  type Target,
} from './support/moderation-realm-boundaries-http-fixture.ts';

let fixture: ModerationRealmFixture;
beforeAll(async () => {
  fixture = await moderationRealmFixture();
}, 120_000);
afterAll(async () => {
  await fixture?.close();
});

async function concealed(actor: Account, path: string, missing: string, secrets: string[]) {
  const denied = await fixture.call(actor, 'GET', path);
  const unknown = await fixture.call(actor, 'GET', missing);
  expect(denied.response.status, `GET ${path} as ${actor.id}: ${denied.text}`).toBe(404);
  expect(unknown.response.status).toBe(404);
  const { request_id: deniedRequest, ...deniedBody } = denied.value;
  const { request_id: missingRequest, ...missingBody } = unknown.value;
  expect(deniedRequest).toEqual(expect.any(String));
  expect(missingRequest).toEqual(expect.any(String));
  expect(deniedBody).toEqual(missingBody);
  for (const secret of secrets) expect(denied.text).not.toContain(secret);
}

async function targetHidden(actor: Account, target: Target, secrets: string[]) {
  const unknown = fixture.missing(target.postId);
  for (const [path, missing] of [
    [`/v1/threads/${target.threadId}`, `/v1/threads/${unknown}`],
    [`/v1/posts/${target.postId}`, `/v1/posts/${unknown}`],
    [`/v1/posts/${target.postId}/revisions`, `/v1/posts/${unknown}/revisions`],
    [`/v1/posts/${target.postId}/revisions/${target.revisionId}`, `/v1/posts/${unknown}/revisions/${unknown}`],
    [`/v1/threads/${target.threadId}/posts`, `/v1/threads/${unknown}/posts`],
  ])
    await concealed(actor, path!, missing!, secrets);
}

test('protected Realm moderation preserves independently owned receipts through a real member ban and registered removal', async () => {
  const f = fixture;
  const live = await f.target('thread', 'Live ban disclosure control');
  const liveReport = await f.report(live, f.member);
  const cases = [];
  for (const kind of ['thread', 'post'] as const) {
    const target = await f.target(kind, `Reported ${kind}`);
    const own = await f.report(target, f.member);
    const other = await f.report(target, f.moderator);
    cases.push({ target, own, other, decisionId: '', appealId: '' });
  }
  await f.settle();
  for (const actor of [f.member, f.moderator]) {
    expect(await f.checked(actor, 'GET', `/v1/realms/${f.realm.realmId}/members/me`)).toMatchObject({
      state: 'member',
    });
    const read = await f.call(actor, 'GET', `/v1/posts/${live.postId}`);
    expect(read.response.status).toBe(200);
    expect(read.text).toContain(live.text);
  }
  const receipt = `/v1/reports/${liveReport.id}`;
  expect(await f.checked(f.member, 'GET', receipt)).toMatchObject({ report: { targetAvailability: 'available' } });

  for (const c of cases) {
    const { target: t } = c;
    const secrets = [t.id, t.postId, t.revisionId, t.text, c.own.id, evidence];
    await targetHidden(f.outsider, t, secrets);
    const exact = `/v1/posts/${t.postId}/revisions/${t.revisionId}`;
    const reference = await f.call(f.moderator, 'GET', exact);
    expect(reference.response.status).toBe(200);
    expect(reference.text).toContain(t.text);
    for (const actor of [f.moderator, f.platform]) {
      expect(await f.checked(actor, 'GET', `/v1/reports/${c.own.id}`)).toMatchObject({
        report: { id: c.own.id, revisionId: t.revisionId, evidence, target: { kind: t.kind, id: t.id } },
      });
      expect(await f.checked(actor, 'GET', `/v1/${t.kind}s/${t.id}/reports?limit=20`)).toMatchObject({
        reports: expect.arrayContaining([expect.objectContaining({ id: c.own.id })]),
      });
    }
    await concealed(f.outsider, `/v1/reports/${c.own.id}`, `/v1/reports/${f.missing(c.own.id)}`, secrets);
    c.decisionId = await f.takeDown(t);
    expect((await f.call(f.moderator, 'GET', exact)).response.status).toBe(404);
    if (t.kind === 'post') {
      const path = `/v1/threads/${t.threadId}/posts`;
      for (const actor of [f.member, f.moderator]) {
        const page = await f.checked<{ posts: Record<string, unknown>[] }>(actor, 'GET', path);
        const withheld = page.posts.find((post) => post.id === t.postId);
        expect(withheld).toMatchObject({ availability: 'withheld', body: null, sha256: null });
        if (actor === f.member) expect(withheld?.decisionId).toBe(c.decisionId);
        else expect(withheld).not.toHaveProperty('decisionId');
      }
    }
  }

  const workflowId = await f.ban();
  for (const c of cases) {
    const path = `/v1/moderation-decisions/${c.decisionId}:appeal`;
    const key = crypto.randomUUID();
    const appeal = await f.checked<{ id: string }>(f.member, 'POST', path, { statement: appealStatement }, 201, key);
    expect(await f.checked(f.member, 'POST', path, { statement: appealStatement }, 201, key)).toEqual(appeal);
    c.appealId = appeal.id;
  }
  for (const stage of ['removal pending', 'removal completed'] as const) {
    if (stage === 'removal completed') await f.completeBan(workflowId);
    await targetHidden(f.member, live, [live.id, live.postId, live.revisionId, live.text, evidence]);
    const replay = await f.call(f.member, 'POST', '/v1/reports', f.reportBody(live), liveReport.key);
    expect(replay.response.status).toBe(404);
    for (const secret of [liveReport.id, live.id, live.text, evidence]) expect(replay.text).not.toContain(secret);
    const ownReceipt = await f.checked(f.member, 'GET', receipt);
    expect(ownReceipt).toMatchObject({
      report: {
        id: liveReport.id,
        evidence,
        revisionId: live.revisionId,
        targetAvailability: 'unavailable',
      },
    });
    expect(JSON.stringify(ownReceipt)).not.toContain(live.text);
    expect((await f.call(f.moderator, 'GET', `/v1/posts/${live.postId}`)).response.status).toBe(200);

    for (const c of cases) {
      const t = c.target;
      const secrets = [
        t.id,
        t.threadId,
        t.postId,
        t.revisionId,
        t.text,
        c.other.id,
        c.decisionId,
        c.appealId,
        evidence,
        reason,
        appealStatement,
      ];
      await targetHidden(f.member, t, secrets);
      for (const actor of [f.member, f.outsider]) {
        await concealed(actor, `/v1/reports/${c.other.id}`, `/v1/reports/${f.missing(c.other.id)}`, secrets);
        await concealed(actor, `/v1/${t.kind}s/${t.id}/reports`, `/v1/${t.kind}s/${f.missing(t.id)}/reports`, secrets);
        for (const suffix of ['reports', 'appeals']) {
          for (const [scope, id] of [
            ['boards', f.board.id],
            ['threads', t.threadId],
          ]) {
            await concealed(actor, `/v1/${scope}/${id}/${suffix}`, `/v1/${scope}/${f.missing(id!)}/${suffix}`, secrets);
          }
        }
      }
      const decisionPath = `/v1/moderation-decisions/${c.decisionId}`;
      await concealed(f.outsider, decisionPath, `/v1/moderation-decisions/${f.missing(c.decisionId)}`, secrets);
      for (const actor of [f.member, f.moderator, f.platform]) {
        const decision = await f.checked(actor, 'GET', decisionPath);
        expect(decision).toMatchObject({
          targetId: t.id,
          statement: reason,
          appeal: { id: c.appealId, outcome: null },
        });
        expect(decision).not.toHaveProperty('deciderId');
        expect(JSON.stringify(decision)).not.toContain(f.moderator.id);
        expect(JSON.stringify(decision)).not.toContain(t.text);
      }
      expect(await f.checked(f.member, 'GET', `/v1/reports/${c.own.id}`)).toMatchObject({
        report: { evidence, outcome: 'actioned', targetAvailability: 'unavailable' },
      });
      for (const actor of [f.moderator, f.platform]) {
        expect(await f.checked(actor, 'GET', `/v1/reports/${c.own.id}`)).toMatchObject({
          report: { evidence, outcome: 'actioned' },
        });
        expect(await f.checked(actor, 'GET', `/v1/${t.kind}s/${t.id}/reports`)).toMatchObject({
          reports: expect.arrayContaining([expect.objectContaining({ id: c.own.id, evidence, outcome: 'actioned' })]),
        });
        if (stage === 'removal completed') {
          for (const [scope, id] of [
            ['boards', f.board.id],
            ['threads', t.threadId],
          ]) {
            const page = await f.checked<{ appeals: Record<string, unknown>[] }>(
              actor,
              'GET',
              `/v1/${scope}/${id}/appeals`,
            );
            expect(page.appeals).toContainEqual(
              expect.objectContaining({
                id: c.appealId,
                decision: { statement: reason, target: { kind: t.kind, id: t.id } },
                canResolve: actor === f.platform,
              }),
            );
            expect(JSON.stringify(page)).not.toContain(f.moderator.id);
          }
        }
      }
    }
  }
}, 180_000);
