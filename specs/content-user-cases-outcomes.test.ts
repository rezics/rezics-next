import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import data from './fixtures/content-user-cases.json';
import type {
  ApiResult,
  Citation,
  ContentUserCasesDriver,
  Figure,
  Fixture,
  PageRequest,
  Persona,
  Post,
  Sort,
  Thread,
} from './content-user-cases-driver';

setDefaultTimeout(120_000);
let driver: ContentUserCasesDriver;
let fixture: Fixture;
let current: ContentUserCasesDriver | undefined;
let serial: number;
beforeEach(async () => {
  const location = process.env.CONTENT_USER_CASES_DRIVER;
  if (!location) throw new Error('Content user cases driver is required');
  if (!isAbsolute(location) && !location.startsWith('file:')) {
    throw new Error('CONTENT_USER_CASES_DRIVER must be an absolute path or file URL');
  }
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('Content user cases driver must use a file URL');
  const binding = await import(url.href);
  if (typeof binding.createContentUserCasesDriver !== 'function') {
    throw new Error('Content user cases driver must export createContentUserCasesDriver');
  }
  current = driver = await binding.createContentUserCasesDriver();
  fixture = await driver.provision();
  expect(fixture.voters).toHaveLength(data.personas.voters.length);
  expect(fixture.voters[0]!.id).toBe(fixture.reader.id);
  expect(fixture.priorVoters).toHaveLength(data.personas.priorVoters.length);
  expect(fixture.privateVoters).toHaveLength(data.personas.privateVoters.length);
  expect(fixture.priorSubjectIds).toHaveLength(data.subjects.priorSubjects.length);
  const voters = [...fixture.voters, ...fixture.priorVoters, ...fixture.privateVoters, fixture.unpublishedVoter];
  expect(new Set(voters.map((voter) => voter.id)).size).toBe(voters.length);
  serial = 0;
});
afterEach(async () => {
  const closing = current;
  current = undefined;
  await closing?.close();
});

const options = (actor = fixture.reader) => ({ actor, key: `"content-user-case-${++serial}"` });
const body = (text: string) => ({
  version: 'rezics-document-v1',
  profile: 'blocks',
  doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
});
function ok<T>(result: ApiResult<T>, status = 200): T {
  expect(result.response.status).toBe(status);
  expect(result.value).not.toBeNull();
  return result.value!;
}
function written<T>(result: ApiResult<T>): T {
  expect([200, 201, 204]).toContain(result.response.status);
  return result.value!;
}
async function concealed(result: ApiResult<unknown>) {
  expect(result.response.status).toBe(404);
  expect(result.value).toBeNull();
  expect(result.response.headers.get('content-type')).toContain('application/problem+json');
  expect(await result.response.clone().json()).toMatchObject({ status: 404 });
}
async function vote(actor: Persona, subjectId = fixture.subjectId, units = data.rating.thresholdVoteUnits) {
  const result = written(await driver.putVote(subjectId, fixture.standardQuestionId, units, options(actor)));
  expect(result).toMatchObject({ subjectId, questionId: fixture.standardQuestionId, units });
  expect(result.revision).toBeGreaterThan(0);
  return result;
}
const citation = (value: Citation): Citation => ({
  questionId: value.questionId,
  units: value.units,
  revision: value.revision,
});
async function review(
  actor = fixture.reader,
  input: {
    boardId?: string;
    subjectId?: string;
    visibility?: 'published' | 'draft';
    voteCitation?: Citation;
  } = {},
) {
  return ok(
    await driver.createThread(
      {
        boardId: input.boardId ?? fixture.publicReviewsBoardId,
        title: `Controlled review ${++serial}`,
        kind: 'review',
        subjectIds: [input.subjectId ?? fixture.subjectId],
        body: body('Controlled review body'),
        licence: data.content.licences[0]!,
        visibility: input.visibility ?? 'published',
        ...(input.voteCitation ? { voteCitation: input.voteCitation } : {}),
      },
      options(actor),
    ),
    201,
  );
}
async function reviews() {
  const items: Thread[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = ok(
      await driver.subjectReviews(fixture.subjectId, fixture.globalContextId, {
        limit: data.content.pageLimit,
        ...(cursor ? { cursor } : {}),
      }),
    );
    expect(page.items.length).toBeLessThanOrEqual(data.content.pageLimit);
    items.push(...page.items);
    if (page.next === null) break;
    expect(cursors.has(page.next)).toBe(false);
    cursors.add(page.next);
    expect(cursors.size).toBeLessThan(30);
    cursor = page.next;
  } while (true);
  expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  return { items, pages: cursors.size + 1 };
}
async function publishedReviews() {
  const originalVote = await vote(fixture.reader);
  const first = await review(fixture.reader, { voteCitation: citation(originalVote) });
  const rest: Thread[] = [];
  for (const actor of fixture.voters.slice(1)) rest.push(await review(actor));
  const changedVote = await vote(fixture.reader, fixture.subjectId, 18);
  await driver.effects('drain');
  return { originalVote, changedVote, first, visible: [first, ...rest] };
}

describe('review-from-vote', () => {
  test('review-from-vote: PUT vote then POST review and change vote; anonymous reads correctly targeted reviews through every relay continuation', async () => {
    const { first, visible } = await publishedReviews();
    const other = await review(fixture.reader, { subjectId: fixture.otherSubjectId });
    await driver.effects('drain');
    const result = await reviews();
    expect(result.pages).toBeGreaterThan(1);
    expect(result.items.map((item) => item.id).sort()).toEqual(visible.map((item) => item.id).sort());
    expect(result.items.map((item) => item.id)).not.toContain(other.id);
    for (const item of result.items) {
      expect(item.kind).toBe('review');
      expect(item.subjectIds).toEqual([fixture.subjectId]);
      expect(item.boardId).toBe(fixture.publicReviewsBoardId);
    }
    expect(result.items.find((item) => item.id === first.id)?.firstPost.id).toBe(first.firstPost.id);
    await driver.effects('replay');
    expect((await reviews()).items.map((item) => item.id).sort()).toEqual(visible.map((item) => item.id).sort());
  });

  test('review-from-vote: citation keeps its publication-time units and revision after the private vote changes', async () => {
    const { first, originalVote, changedVote } = await publishedReviews();
    expect(changedVote.revision).toBeGreaterThan(originalVote.revision);
    const listed = (await reviews()).items.find((item) => item.id === first.id)!;
    expect(listed.firstPost.voteCitation).toEqual(citation(originalVote));
    const exact = ok(await driver.readRevision(first.firstPost.id, first.firstPost.revisionId, null));
    expect(exact.voteCitation).toEqual(citation(originalVote));
    expect(
      ok(await driver.ownVote(fixture.subjectId, fixture.standardQuestionId, fixture.reader, fixture.reader)),
    ).toMatchObject(changedVote);
  });

  test('review-from-vote: hidden and protected posts stay out of public pages while immutable revisions and licences survive', async () => {
    const { first, originalVote, visible } = await publishedReviews();
    const draft = await review(fixture.outsider, { visibility: 'draft' });
    const protectedReview = await review(fixture.reader, { boardId: fixture.protectedReviewsBoardId });
    const hidden = await review(fixture.moderator);
    written(await driver.takedown({ kind: 'post', id: hidden.firstPost.id }, options(fixture.moderator)));
    const before = ok(await driver.readRevision(first.firstPost.id, first.firstPost.revisionId, null));
    const revised = written(
      await driver.revise(
        first.firstPost,
        {
          body: body('Controlled revised review body'),
          licence: data.content.licences[1]!,
        },
        options(),
      ),
    );
    expect(revised.revisionId).not.toBe(before.revisionId);
    await driver.effects('drain');
    const listed = await reviews();
    expect(listed.pages).toBeGreaterThan(1);
    expect(listed.items.map((item) => item.id).sort()).toEqual(visible.map((item) => item.id).sort());
    for (const item of [draft, protectedReview, hidden]) {
      await concealed(await driver.readPost(item.firstPost.id, null));
      await concealed(await driver.readRevision(item.firstPost.id, item.firstPost.revisionId, null));
      expect(JSON.stringify(listed.items)).not.toContain(item.firstPost.id);
    }
    expect(ok(await driver.readRevision(before.id, before.revisionId, null))).toEqual(before);
    expect(before).toMatchObject({
      licence: 'MIT',
      subjectIds: [fixture.subjectId],
      voteCitation: citation(originalVote),
    });
    expect(ok(await driver.readPost(before.id, null))).toMatchObject({
      revisionId: revised.revisionId,
      licence: 'CC-BY-4.0',
      subjectIds: [fixture.subjectId],
    });
  });
});

async function prior() {
  for (const subjectId of fixture.priorSubjectIds) {
    for (const actor of fixture.priorVoters) await vote(actor, subjectId, data.rating.priorVoteUnits);
  }
  await driver.effects('drain');
}
function context(figure: Figure, count: number) {
  expect(figure).toMatchObject({
    questionId: fixture.standardQuestionId,
    populationId: fixture.globalPopulationId,
    count,
    units: { minimum: 0, maximum: 20, displayStep: 0.5 },
  });
}
async function matchingFigures(subjectId: string, count: number) {
  const page = ok(await driver.subjectFigure(subjectId, null));
  const card = ok(await driver.searchCard(subjectId, null));
  expect(card.subjectId).toBe(subjectId);
  context(page, count);
  expect(card.figure).toEqual(page);
  return page;
}
function noNumber(figure: Figure) {
  expect(['insufficient_data', 'updating']).toContain(figure.state);
  expect(figure.mean ?? null).toBeNull();
  expect(figure.score ?? null).toBeNull();
}

describe('subject-rating-context', () => {
  test('subject-rating-context: subject page and search card agree on standard question Global population units and count with a real prior', async () => {
    await prior();
    for (const actor of fixture.voters) await vote(actor);
    await driver.effects('drain');
    const figure = await matchingFigures(fixture.subjectId, data.rating.threshold);
    expect(figure.state).toBe('ready');
    expect(figure.mean).toBe(4);
    expect(typeof figure.score).toBe('number');
    expect(figure.score!).toBeGreaterThan(4);
    expect(figure.score!).toBeLessThan(6);
  });

  test('subject-rating-context: below threshold and unpublished updates honestly show insufficient data or updating without a number', async () => {
    await prior();
    for (const actor of fixture.voters.slice(0, 4)) await vote(actor, fixture.belowThresholdSubjectId);
    await driver.effects('drain');
    noNumber(await matchingFigures(fixture.belowThresholdSubjectId, 4));
    // Pending votes are not a licence to fabricate an already-published number.
    await vote(fixture.unpublishedVoter, fixture.belowThresholdSubjectId, 20);
    noNumber(ok(await driver.subjectFigure(fixture.belowThresholdSubjectId, null)));
    noNumber(ok(await driver.searchCard(fixture.belowThresholdSubjectId, null)).figure);
    written(await driver.suspend(fixture.unpublishedVoter, options(fixture.moderator)));
    await driver.effects('drain');
    noNumber(await matchingFigures(fixture.belowThresholdSubjectId, 4));
    await vote(fixture.voters[4]!, fixture.belowThresholdSubjectId);
    await driver.effects('drain');
    const ready = await matchingFigures(fixture.belowThresholdSubjectId, 5);
    expect(ready.state).toBe('ready');
    expect(ready.mean).toBe(4);
  });

  test('subject-rating-context: only the reader can obtain their own vote and public consumers expose no individual vote', async () => {
    const own = await vote(fixture.reader);
    expect(
      ok(await driver.ownVote(fixture.subjectId, fixture.standardQuestionId, fixture.reader, fixture.reader)),
    ).toEqual(own);
    for (const viewer of [null, fixture.outsider]) {
      const result = await driver.ownVote(fixture.subjectId, fixture.standardQuestionId, fixture.reader, viewer);
      expect([401, 403, 404]).toContain(result.response.status);
      expect(result.value).toBeNull();
      expect(result.response.headers.get('content-type')).toContain('application/problem+json');
      expect(await result.response.clone().text()).not.toContain(fixture.reader.id);
    }
    await driver.effects('drain');
    for (const result of [
      await driver.subjectFigure(fixture.subjectId, null),
      await driver.searchCard(fixture.subjectId, null),
    ]) {
      ok(result);
      const wire = await result.response.clone().text();
      expect(wire).not.toContain(fixture.reader.id);
      expect(wire).not.toContain('voteCitation');
    }
  });

  test('subject-rating-context: an extreme private Realm population never substitutes for or moves the public Global figure', async () => {
    await prior();
    for (const actor of fixture.voters) await vote(actor);
    // Realm membership segments these SAME Global votes; it never creates extra votes.
    for (const actor of fixture.privateVoters) await vote(actor, fixture.subjectId, data.rating.privateVoteUnits);
    await driver.effects('drain');
    const before = await matchingFigures(fixture.subjectId, 15);
    expect(before.mean).toBe(8);
    for (const actor of fixture.privateVoters) {
      written(await driver.joinPrivateRealm(actor, options(fixture.moderator)));
    }
    await driver.effects('drain');
    const privateFigure = ok(await driver.realmFigure(fixture.subjectId, fixture.privateRealmId, fixture.moderator));
    expect(privateFigure).toMatchObject({ populationId: fixture.privateRealmId, count: 10, mean: 10, state: 'ready' });
    expect(await matchingFigures(fixture.subjectId, 15)).toEqual(before);
    await concealed(await driver.realmFigure(fixture.subjectId, fixture.privateRealmId, null));
    await concealed(await driver.realmFigure(fixture.subjectId, fixture.privateRealmId, fixture.outsider));
    for (const result of [
      await driver.subjectFigure(fixture.subjectId, null),
      await driver.searchCard(fixture.subjectId, null),
    ]) {
      expect(await result.response.clone().text()).not.toContain(fixture.privateRealmId);
    }
  });
});

async function pageData(protectedBoard: boolean) {
  const board = ok(
    await driver.createBoard(protectedBoard ? 'protected' : 'published', options(fixture.moderator)),
    201,
  );
  const threads: Thread[] = [];
  const posts: Post[] = [];
  for (let i = 0; i < 5; i++) {
    const thread = ok(
      await driver.createThread(
        {
          boardId: board.id,
          title: `Controlled barrier thread ${++serial}`,
          kind: 'discussion',
          subjectIds: [fixture.subjectId],
          body: body('Controlled barrier opening'),
          licence: 'MIT',
          visibility: 'published',
        },
        options(),
      ),
      201,
    );
    threads.push(thread);
    posts.push(thread.firstPost);
    for (let j = 0; j < 5; j++) {
      posts.push(
        ok(
          await driver.createPost(
            {
              threadId: thread.id,
              body: body(`Controlled barrier reply ${j}`),
              licence: 'MIT',
            },
            options(),
          ),
          201,
        ),
      );
    }
  }
  await driver.effects('drain');
  return { board, threads, posts };
}
async function pageCase(kind: Sort | 'posts', change: 'takedown' | 'grant' | 'none', protectedControl = false) {
  // Separate boards make first-page and continuation revocations independent.
  for (const continuation of [false, true]) {
    const setup = await pageData(change === 'grant' || protectedControl);
    let request: PageRequest =
      kind === 'posts'
        ? { kind: 'posts', boardId: setup.board.id, threadId: setup.threads[0]!.id, actor: fixture.reader, limit: 2 }
        : { kind: 'board', boardId: setup.board.id, sort: kind, actor: fixture.reader, limit: 2 };
    const first = ok(await driver.page(request));
    expect(first.items).toHaveLength(2);
    expect(first.next).not.toBeNull();
    if (continuation) request = { ...request, cursor: first.next! };
    const baseline = ok(await driver.page(request));
    expect(baseline.items).toHaveLength(2);
    const held = await driver.holdPage(request);
    try {
      await held.reached;
      if (change === 'takedown') {
        written(await driver.takedown({ kind: 'board', id: setup.board.id }, options(fixture.moderator)));
      } else if (change === 'grant') {
        written(await driver.revokeBoardRead(setup.board.id, fixture.reader, options(fixture.moderator)));
      }
    } finally {
      await held.release();
    }
    const result = await held.response;
    if (change === 'none') {
      expect(ok(result)).toEqual(baseline);
      continue;
    }
    expect([200, 404]).toContain(result.response.status);
    if (result.response.status === 200) {
      const empty = ok(result);
      expect(empty.items).toEqual([]);
      expect(empty.next).toBeNull();
      expect(empty.count ?? 0).toBe(0);
      expect(empty.summary ?? null).toBeNull();
      expect(empty.sources ?? []).toEqual([]);
    } else await concealed(result);
    const raw = await result.response.clone().json();
    function noMaterial(value: unknown) {
      if (value === null || typeof value !== 'object') return;
      for (const [name, child] of Object.entries(value)) {
        if (/^(?:count|total|totalCount|summary|sources?|cursor|next|nextCursor)$/i.test(name)) {
          expect(child === null || child === 0 || (Array.isArray(child) && child.length === 0)).toBe(true);
        }
        noMaterial(child);
      }
    }
    noMaterial(raw);
    const wire = `${JSON.stringify(raw)} ${JSON.stringify([...result.response.headers])}`;
    const secrets = [
      setup.board.id,
      fixture.subjectId,
      first.next!,
      baseline.next,
      ...setup.threads.flatMap((thread) => [thread.id, thread.title]),
      ...setup.posts.flatMap((post) => [post.id, post.revisionId]),
      'Controlled barrier opening',
      'Controlled barrier reply',
    ];
    for (const secret of secrets) if (secret) expect(wire).not.toContain(secret);
  }
}

describe('late-board-revocation-pages', () => {
  test('late-board-revocation-pages: hot board first and continuation pages conceal a late takedown', async () => {
    await pageCase('hot', 'takedown');
  });
  test('late-board-revocation-pages: active board first and continuation pages conceal a late takedown', async () => {
    await pageCase('active', 'takedown');
  });
  test('late-board-revocation-pages: newest board first and continuation pages conceal a late takedown', async () => {
    await pageCase('newest', 'takedown');
  });
  test('late-board-revocation-pages: hot protected board first and continuation pages conceal a late read-grant revocation', async () => {
    await pageCase('hot', 'grant');
  });
  test('late-board-revocation-pages: active protected board first and continuation pages conceal a late read-grant revocation', async () => {
    await pageCase('active', 'grant');
  });
  test('late-board-revocation-pages: newest protected board first and continuation pages conceal a late read-grant revocation', async () => {
    await pageCase('newest', 'grant');
  });
  test('late-board-revocation-pages: thread post first and continuation pages conceal a late board takedown', async () => {
    await pageCase('posts', 'takedown');
  });
  test('late-board-revocation-pages: thread post first and continuation pages conceal a late protected board read-grant revocation', async () => {
    await pageCase('posts', 'grant');
  });
  test('late-board-revocation-pages: unchanged hot board first and continuation pages answer normally', async () => {
    await pageCase('hot', 'none');
    await pageCase('hot', 'none', true);
  });
  test('late-board-revocation-pages: unchanged active board first and continuation pages answer normally', async () => {
    await pageCase('active', 'none');
    await pageCase('active', 'none', true);
  });
  test('late-board-revocation-pages: unchanged newest board first and continuation pages answer normally', async () => {
    await pageCase('newest', 'none');
    await pageCase('newest', 'none', true);
  });
  test('late-board-revocation-pages: unchanged thread post first and continuation pages answer normally', async () => {
    await pageCase('posts', 'none');
    await pageCase('posts', 'none', true);
  });
});
