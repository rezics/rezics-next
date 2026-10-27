import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  ApiResult,
  ContentNotificationDriver,
  Fixture,
  Notice,
  Persona,
  Post,
  Target,
  Thread,
} from './content-notification-driver';

setDefaultTimeout(60_000);
let driver: ContentNotificationDriver;
let fixture: Fixture;
let current: ContentNotificationDriver | undefined;
let serial: number;
beforeEach(async () => {
  const location = process.env.CONTENT_NOTIFICATION_DRIVER;
  if (!location) throw new Error('Content notification outcome driver is required');
  if (!isAbsolute(location) && !location.startsWith('file:')) {
    throw new Error('CONTENT_NOTIFICATION_DRIVER must be an absolute path or file URL');
  }
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('Content notification driver must use a file URL');
  const binding = await import(url.href);
  if (typeof binding.createContentNotificationDriver !== 'function') {
    throw new Error('Content notification driver must export createContentNotificationDriver');
  }
  current = driver = await binding.createContentNotificationDriver();
  fixture = await driver.provision();
  expect(fixture.readers).toHaveLength(11);
  serial = 0;
});
afterEach(async () => {
  const closing = current;
  current = undefined;
  await closing?.close();
});

// The mention node is the document contract; no adapter parses text for mentions.
const body = (accounts: Persona[] = []) => ({
  version: 'rezics-document-v1',
  profile: 'blocks',
  doc: {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Notification source body' },
          ...accounts.map((account) => ({ type: 'mention', attrs: { accountId: account.id } })),
        ],
      },
    ],
  },
});
const options = (actor = fixture.author) => ({ actor, key: `"notification-${++serial}"` });
function ok<T>(result: ApiResult<T>, status = 200): T {
  expect(result.response.status).toBe(status);
  expect(result.value).not.toBeNull();
  return result.value!;
}
function written<T>(result: ApiResult<T>): T {
  expect([200, 201, 204]).toContain(result.response.status);
  return result.value!;
}
async function problem(result: ApiResult<unknown>, status: number) {
  expect(result.response.status).toBe(status);
  expect(result.value).toBeNull();
  expect(result.response.headers.get('content-type')).toContain('application/problem+json');
  expect(await result.response.clone().json()).toMatchObject({ status });
}
async function thread(protectedRealm = false, actor = fixture.author): Promise<Thread> {
  return ok(
    await driver.createThread(
      {
        boardId: protectedRealm ? fixture.protectedBoardId : fixture.publicBoardId,
        body: body(),
        visibility: 'published',
      },
      options(actor),
    ),
    201,
  );
}
async function post(
  t: Thread,
  actor = fixture.replier,
  mentions: Persona[] = [],
  parent?: Post,
  visibility: 'published' | 'draft' = 'published',
): Promise<Post> {
  return ok(
    await driver.createPost(
      {
        threadId: t.id,
        ...(parent ? { parentId: parent.id } : {}),
        body: body(mentions),
        visibility,
      },
      options(actor),
    ),
    201,
  );
}
async function inbox(actor: Persona, limit = 50): Promise<Notice[]> {
  const items: Notice[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = ok(await driver.inbox(actor.id, actor, { limit, ...(cursor ? { cursor } : {}) }));
    expect(page.items.length).toBeLessThanOrEqual(limit);
    items.push(...page.items);
    if (page.next === null) break;
    expect(typeof page.next).toBe('string');
    expect(page.next.length).toBeGreaterThan(0);
    expect(cursors.has(page.next)).toBe(false);
    cursors.add(page.next);
    expect(cursors.size).toBeLessThan(200);
    cursor = page.next;
  } while (true);
  expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  return items;
}
async function noticesFor(actor: Persona, source: Post) {
  return (await inbox(actor)).filter((item) => item.target.postId === source.id);
}
const target = (p: Post): Target => ({ kind: 'post', id: p.id });
const daysAfter = (instant: string, days: number, extraMs = 0) =>
  new Date(Date.parse(instant) + days * 86_400_000 + extraMs).toISOString();

test("a reply notifies the parent post's author and a top-level post notifies the thread's author, once each, never the actor", async () => {
  const t = await thread();
  const parent = await post(t, fixture.mentioned);
  const reply = await post(t, fixture.replier, [fixture.mentioned, fixture.author, fixture.replier], parent);
  const top = await post(t, fixture.replier, [fixture.author, fixture.replier]);
  const self = await post(t, fixture.author, [fixture.author], t.firstPost);
  await driver.effects('drain');
  const parentNotices = await noticesFor(fixture.mentioned, reply);
  expect(parentNotices).toHaveLength(1);
  expect(parentNotices[0]).toMatchObject({
    kind: 'reply',
    actorId: fixture.replier.id,
    target: { threadId: t.id, postId: reply.id },
    unread: true,
  });
  // Mentioning the opening author in a nested reply still produces a mention.
  expect(await noticesFor(fixture.author, reply)).toEqual([
    expect.objectContaining({ kind: 'mention', actorId: fixture.replier.id }),
  ]);
  expect(await noticesFor(fixture.author, top)).toEqual([
    expect.objectContaining({ kind: 'reply', actorId: fixture.replier.id }),
  ]);
  expect(await inbox(fixture.replier)).toEqual([]);
  expect(await noticesFor(fixture.author, self)).toEqual([]);
});

test("a mention in a post's first published revision notifies each mentioned account up to ten, and a later revision notifies nobody", async () => {
  const t = await thread();
  const recipients = fixture.readers;
  // Repetitions do not consume the ten distinct-account slots.
  const p = await post(t, fixture.replier, [recipients[0]!, recipients[0]!, ...recipients.slice(1)]);
  await driver.effects('drain');
  for (const [index, account] of recipients.entries()) {
    const items = await noticesFor(account, p);
    expect(items).toHaveLength(index < 10 ? 1 : 0);
    if (items.length) expect(items[0]).toMatchObject({ kind: 'mention', actorId: fixture.replier.id });
  }
  ok(
    await driver.revise(
      { post: p, body: body([recipients[10]!, fixture.mentioned]), visibility: 'published' },
      options(fixture.replier),
    ),
  );
  await driver.effects('drain');
  expect(await noticesFor(recipients[10]!, p)).toEqual([]);
  expect(await noticesFor(fixture.mentioned, p)).toEqual([]);
  expect(await noticesFor(recipients[0]!, p)).toHaveLength(1);

  const draft = await post(t, fixture.replier, [fixture.mentioned], undefined, 'draft');
  await driver.effects('drain');
  expect(await noticesFor(fixture.mentioned, draft)).toEqual([]);
  ok(
    await driver.revise(
      { post: draft, body: body([recipients[10]!]), visibility: 'published' },
      options(fixture.replier),
    ),
  );
  await driver.effects('drain');
  expect(await noticesFor(fixture.mentioned, draft)).toEqual([]);
  expect(await noticesFor(recipients[10]!, draft)).toEqual([expect.objectContaining({ kind: 'mention' })]);

  const opening = ok(
    await driver.createThread(
      { boardId: fixture.publicBoardId, body: body([fixture.mentioned]), visibility: 'published' },
      options(),
    ),
    201,
  );
  await driver.effects('drain');
  expect(await noticesFor(fixture.mentioned, opening.firstPost)).toEqual([
    expect.objectContaining({ kind: 'mention', actorId: fixture.author.id }),
  ]);
});

test('a recipient who cannot read the post at send time, who turned the kind off, or who is deleted receives nothing', async () => {
  const t = await thread(true);
  const p = await post(t, fixture.replier, [fixture.mentioned, fixture.nonMember, fixture.reporter]);
  // These changes happen after publication but before committed effects run.
  await driver.fixtures.realmMember(fixture.mentioned, false);
  await driver.fixtures.notificationAllowed(fixture.author, 'reply', false);
  await driver.fixtures.accountState(fixture.reporter, 'deleted');
  await driver.effects('drain');
  expect(await noticesFor(fixture.author, p)).toEqual([]);
  expect(await noticesFor(fixture.mentioned, p)).toEqual([]);
  expect(await noticesFor(fixture.nonMember, p)).toEqual([]);
  await driver.fixtures.accountState(fixture.reporter, 'active');
  expect(await noticesFor(fixture.reporter, p)).toEqual([]);
  await driver.fixtures.realmMember(fixture.mentioned, true);
  await driver.fixtures.realmMember(fixture.nonMember, true);
  await driver.fixtures.realmMember(fixture.reporter, true);
  await driver.fixtures.notificationAllowed(fixture.author, 'reply', true);
  await driver.effects('replay');
  for (const actor of [fixture.author, fixture.mentioned, fixture.nonMember, fixture.reporter]) {
    expect(await noticesFor(actor, p)).toEqual([]);
  }
  const publicThread = await thread();
  await driver.fixtures.notificationAllowed(fixture.mentioned, 'mention', false);
  const off = await post(publicThread, fixture.replier, [fixture.mentioned]);
  await driver.effects('drain');
  expect(await noticesFor(fixture.mentioned, off)).toEqual([]);
  await driver.fixtures.notificationAllowed(fixture.mentioned, 'mention', true);
  await driver.effects('replay');
  expect(await noticesFor(fixture.mentioned, off)).toEqual([]);
});

test('replayed events add no second notice', async () => {
  const t = await thread();
  await post(t, fixture.replier, [fixture.mentioned]);
  await driver.effects('drain');
  const before = await Promise.all([inbox(fixture.author), inbox(fixture.mentioned)]);
  expect(before.map((items) => items.length)).toEqual([1, 1]);
  await driver.effects('replay');
  await driver.effects('replay');
  expect(await Promise.all([inbox(fixture.author), inbox(fixture.mentioned)])).toEqual(before);
});

test("the inbox lists only the viewer's notices newest first with an opaque cursor and skips items whose post the viewer can no longer read", async () => {
  const t = await thread();
  const oldest = await post(t);
  await driver.fixtures.now(daysAfter(fixture.now, 1));
  const hidden = await thread(true);
  const secret = await post(hidden);
  await driver.fixtures.now(daysAfter(fixture.now, 2));
  const newest = await post(t);
  await driver.effects('drain');
  const all = await inbox(fixture.author, 1);
  expect(all.map((n) => n.target.postId)).toEqual([newest.id, secret.id, oldest.id]);
  expect(all.map((n) => n.createdAt)).toEqual([...all.map((n) => n.createdAt)].sort().reverse());
  const page = ok(await driver.inbox(fixture.author.id, fixture.author, { limit: 1 }));
  expect(page.next).not.toBeNull();
  const cursor = page.next!;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  for (const id of [fixture.author.id, ...all.map((n) => n.id), secret.id]) {
    expect(cursor).not.toContain(id);
    expect(decoded).not.toContain(id);
  }
  await problem(await driver.inbox(fixture.author.id, fixture.replier), 404);
  await problem(await driver.unread(fixture.author.id, fixture.replier), 404);
  await problem(await driver.markSeen(fixture.author.id, all[0]!.id, options(fixture.replier)), 404);
  await problem(await driver.markSeen(fixture.replier.id, all[0]!.id, options(fixture.replier)), 404);
  await problem(await driver.inbox(fixture.mentioned.id, fixture.mentioned, { limit: 1, cursor }), 400);
  const tampered = `${cursor[0] === 'A' ? 'B' : 'A'}${cursor.slice(1)}`;
  await problem(await driver.inbox(fixture.author.id, fixture.author, { limit: 1, cursor: tampered }), 400);
  for (const limit of [0, 51]) await problem(await driver.inbox(fixture.author.id, fixture.author, { limit }), 400);
  await driver.fixtures.realmMember(fixture.author, false);
  await problem(await driver.readPost(secret, fixture.author), 404);
  const visible = await inbox(fixture.author, 1);
  expect(visible.map((n) => n.target.postId)).toEqual([newest.id, oldest.id]);
  const continued = await driver.inbox(fixture.author.id, fixture.author, { limit: 1, cursor });
  const wire = JSON.stringify(await continued.response.clone().json());
  ok(continued);
  expect(wire).not.toContain(secret.id);
  expect(wire).not.toContain(all[1]!.id);
  expect(await inbox(fixture.replier)).toEqual([]);
});

test('the unread count stops at 100 and the seen marker never moves backward', async () => {
  const t = await thread();
  expect(ok(await driver.unread(fixture.author.id, fixture.author))).toEqual({ count: 0, capped: false });
  for (let i = 0; i < 100; i++) await post(t);
  await driver.effects('drain');
  expect(ok(await driver.unread(fixture.author.id, fixture.author))).toEqual({ count: 100, capped: false });
  await post(t);
  await driver.effects('drain');
  expect(ok(await driver.unread(fixture.author.id, fixture.author))).toEqual({ count: 100, capped: true });
  const items = await inbox(fixture.author);
  expect(items).toHaveLength(101);
  expect(items.every((n) => n.unread)).toBe(true);
  expect(ok(await driver.inbox(fixture.author.id, fixture.author)).items).toHaveLength(20);
  written(await driver.markSeen(fixture.author.id, items[1]!.id, options()));
  expect(ok(await driver.unread(fixture.author.id, fixture.author))).toEqual({ count: 1, capped: false });
  written(await driver.markSeen(fixture.author.id, items[100]!.id, options()));
  const after = await inbox(fixture.author);
  expect(after.map((n) => n.unread)).toEqual([true, ...Array(100).fill(false)]);
  written(await driver.markSeen(fixture.author.id, items[0]!.id, options()));
  expect(ok(await driver.unread(fixture.author.id, fixture.author))).toEqual({ count: 0, capped: false });
});

test('a takedown sends its author the decision with its statement and appeal deadline whatever their preferences', async () => {
  await driver.fixtures.notificationAllowed(fixture.author, 'moderation_decision', false);
  for (const kind of ['thread', 'post'] as const) {
    const t = await thread();
    const subject = kind === 'thread' ? { kind, id: t.id } : target(await post(t, fixture.author));
    const reason = `Decision statement for ${kind}`;
    const result = written(await driver.takedown(subject, reason, options(fixture.moderator)));
    const decision = ok(await driver.decision(result.decisionId, fixture.author));
    expect(decision).toMatchObject({
      id: result.decisionId,
      target: subject,
      action: 'takedown',
      statement: reason,
      deciderId: fixture.moderator.id,
    });
    expect(decision.appealDeadline).toBe(daysAfter(decision.createdAt, 183));
    await driver.effects('drain');
    const notice = (await inbox(fixture.author)).filter((n) => n.target.decisionId === decision.id);
    expect(notice).toEqual([expect.objectContaining({ kind: 'moderation_decision', actorId: null })]);
    expect(JSON.stringify(notice)).not.toContain(reason);
    expect(await inbox(fixture.moderator)).toEqual([]);
    await problem(await driver.decision(decision.id, fixture.nonMember), 404);
  }
});

test('resolving a report sends its reporter actioned or dismissed', async () => {
  const t = await thread();
  const actioned = target(await post(t, fixture.author));
  const dismissed = target(await post(t, fixture.author));
  const first = ok(await driver.report(actioned, options(fixture.reporter)), 201);
  const second = ok(await driver.report(dismissed, options(fixture.reporter)), 201);
  const third = ok(await driver.report(actioned, options(fixture.mentioned)), 201);
  written(await driver.takedown(actioned, 'Action on reported content', options(fixture.moderator)));
  written(await driver.dismissReport(second.reportId, 'No violation', options(fixture.moderator)));
  await driver.effects('drain');
  for (const [report, actor, outcome] of [
    [first, fixture.reporter, 'actioned'],
    [second, fixture.reporter, 'dismissed'],
    [third, fixture.mentioned, 'actioned'],
  ] as const) {
    expect(ok(await driver.readReport(report.reportId, actor))).toMatchObject({ id: report.reportId, outcome });
    expect((await inbox(actor)).filter((n) => n.target.reportId === report.reportId)).toEqual([
      expect.objectContaining({ kind: 'moderation_decision', actorId: null }),
    ]);
  }
  // A later takedown cannot replace an already dismissed outcome or notify twice.
  written(await driver.takedown(dismissed, 'Later decision', options(fixture.moderator)));
  await driver.effects('drain');
  await driver.effects('replay');
  expect(ok(await driver.readReport(second.reportId, fixture.reporter)).outcome).toBe('dismissed');
  const notices = await inbox(fixture.reporter);
  expect(notices).toHaveLength(2);
  expect(notices.every((n) => n.kind === 'moderation_decision' && n.actorId === null)).toBe(true);
});

test('the author appeals once within six months and another moderator upholds or reverses, and a reversal makes the target readable and notifies the author', async () => {
  for (const outcome of ['uphold', 'reverse'] as const) {
    const t = await thread();
    // Cover both content target kinds, and read through the thread after reversal.
    const p = await post(t, fixture.author);
    const subject: Target = outcome === 'uphold' ? target(p) : { kind: 'thread', id: t.id };
    ok(await driver.readTarget(subject, fixture.mentioned));
    const decision = written(await driver.takedown(subject, 'Original reason', options(fixture.moderator)));
    await driver.effects('drain');
    await problem(await driver.readTarget(subject, fixture.mentioned), 404);
    const appeal = ok(await driver.appeal(decision.decisionId, 'Please reconsider', options()), 201);
    expect(appeal).toMatchObject({
      decisionId: decision.decisionId,
      appellantId: fixture.author.id,
      statement: 'Please reconsider',
      outcome: 'pending',
      resolutionStatement: null,
    });
    expect(ok(await driver.pendingAppeals(fixture.secondModerator)).some((a) => a.id === appeal.id)).toBe(true);
    const beforeNotices = await inbox(fixture.author);
    const resolution = written(
      await driver.resolveAppeal(appeal.id, outcome, 'Independent review', options(fixture.secondModerator)),
    );
    expect(resolution).toMatchObject({ id: appeal.id, outcome, resolutionStatement: 'Independent review' });
    expect(ok(await driver.pendingAppeals(fixture.secondModerator)).some((a) => a.id === appeal.id)).toBe(false);
    await driver.effects('drain');
    const afterNotices = await inbox(fixture.author);
    const added = afterNotices.filter((n) => !beforeNotices.some((old) => old.id === n.id));
    expect(added).toEqual([
      expect.objectContaining({
        kind: 'moderation_decision',
        actorId: null,
        target: expect.objectContaining({ decisionId: decision.decisionId }),
      }),
    ]);
    if (outcome === 'reverse') {
      const restored = ok(await driver.readTarget(subject, fixture.mentioned));
      expect(BigInt(restored.securityRevision)).toBeGreaterThan(BigInt(decision.securityRevision));
      ok(await driver.readPost(p, fixture.mentioned));
    } else await problem(await driver.readTarget(subject, fixture.mentioned), 404);
    await driver.effects('replay');
    expect(await inbox(fixture.author)).toEqual(afterNotices);
  }
});

test('the decider cannot resolve the appeal, a second appeal is refused, and an appeal after six months is refused', async () => {
  const t = await thread();
  const p = await post(t, fixture.author);
  const decision = written(await driver.takedown(target(p), 'Reason', options(fixture.moderator)));
  await problem(await driver.appeal(decision.decisionId, 'Not my decision', options(fixture.replier)), 404);
  await problem(await driver.appeal(decision.decisionId, 'x'.repeat(2001), options()), 422);
  const read = ok(await driver.decision(decision.decisionId, fixture.author));
  // The deadline is inclusive; the next millisecond is late.
  await driver.fixtures.now(read.appealDeadline);
  const appeal = ok(await driver.appeal(decision.decisionId, 'x'.repeat(2000), options()), 201);
  await problem(await driver.resolveAppeal(appeal.id, 'reverse', 'Own review', options(fixture.moderator)), 403);
  await problem(await driver.resolveAppeal(appeal.id, 'reverse', 'No authority', options(fixture.replier)), 403);
  expect(ok(await driver.pendingAppeals(fixture.secondModerator)).find((a) => a.id === appeal.id)?.outcome).toBe(
    'pending',
  );
  await problem(await driver.appeal(decision.decisionId, 'Again', options()), 409);
  written(await driver.resolveAppeal(appeal.id, 'uphold', 'Final review', options(fixture.secondModerator)));
  await problem(await driver.appeal(decision.decisionId, 'After resolution', options()), 409);
  const latePost = await post(t, fixture.author);
  const lateDecision = written(await driver.takedown(target(latePost), 'Later reason', options(fixture.moderator)));
  const late = ok(await driver.decision(lateDecision.decisionId, fixture.author));
  await driver.fixtures.now(daysAfter(late.createdAt, 183, 1));
  await problem(await driver.appeal(late.id, 'Too late', options()), 422);
  expect(ok(await driver.pendingAppeals(fixture.secondModerator))).toEqual([]);
});
