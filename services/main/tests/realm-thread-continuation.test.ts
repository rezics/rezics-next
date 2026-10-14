import { expect, test } from 'bun:test';
import { fromMarkdown } from '@rezics/document';
import { authoredDocumentBody } from '../../content/src/document-body.ts';
import { readRealmThread, readRealmThreads } from '../src/modules/realm-reply/thread-read.ts';
import { REALM_THREAD_COST } from '../src/modules/realm-reply/thread-contract.ts';
import type { ThreadVote } from '../src/modules/realm-reply/thread-store.ts';
import { WorkReadExpired, WorkReadInvalid, WorkReadMissing, WorkReadMoved, WorkReadSession, WorkReadUnavailable }
  from '../src/modules/work/read-session.ts';
import { realm, reply, work, world } from './realm-reply-threads.test.ts';
import { targetSummaries } from '../src/modules/target/resolve.ts';

const siblings = (count: number) => [{ id: 1, author: 1 },
  ...Array.from({ length: count }, (_, index) => ({ id: index + 2, parent: 1, author: 1 }))];
const branch = (depth: number) => Array.from({ length: depth + 1 }, (_, index) =>
  ({ id: index + 1, author: 1, ...(index ? { parent: index } : {}) }));
const siblingCursor = (read: Awaited<ReturnType<typeof readRealmThread>>) => {
  const continuation = read.continuations.find(item => item.kind === 'siblings');
  if (!continuation || continuation.kind !== 'siblings') throw new Error('Missing sibling continuation');
  return continuation;
};

test('anonymous pages carry the exact display-language basis used by their sibling cursors', async () => {
  const { session } = world(siblings(192));
  const languages = ['ja', 'en', 'en-US'];
  Object.assign(session, { displayLanguages: languages });
  const first = await readRealmThread(session, realm, reply(1), 'new');
  expect(first.displayLanguages).toEqual(languages);
  const next = siblingCursor(first);
  const second = await readRealmThread(session, realm, next.reply, 'new', next.cursor);
  expect(second.displayLanguages).toEqual(languages);
  expect(new Set([...first.items.slice(1), ...second.items.slice(1)].map(item => item.reply)).size).toBe(192);
});

test('sibling 192 is reachable in the existing reply order, with the focus repeated only as context', async () => {
  for (const sort of ['best', 'top', 'new'] as const) {
    const placed = siblings(192);
    const { session } = world(placed, { votes: { 2: { score: 100 }, 193: { score: -100 } } });
    const first = await readRealmThread(session, realm, reply(1), sort);
    expect(first.items).toHaveLength(REALM_THREAD_COST.replies + 1);
    expect(first.complete).toBe(false);
    const next = siblingCursor(first);
    expect(next.reply).toBe(reply(1));
    const second = await readRealmThread(session, realm, next.reply, sort, next.cursor);
    expect(second.items).toHaveLength(2);
    expect(second.continuations).toEqual([]);
    expect(second.complete).toBe(true);
    const combined = [...first.items.slice(1), ...second.items.slice(1)].map(item => item.reply);
    expect(new Set(combined).size).toBe(192);
    expect(combined).toContain(reply(2));
    expect(combined).toContain(reply(193));
  }
});

for (const sort of ['best', 'top'] as const) {
  for (const change of ['promote-unread', 'demote-delivered'] as const) {
    test(`${sort} sibling cursors restart when a vote ${change} changes their order`, async () => {
      const votes: Record<number, Partial<ThreadVote>> = {};
      const { session } = world(siblings(192), { votes });
      const first = await readRealmThread(session, realm, reply(1), sort);
      expect(first.items.some(item => item.reply === reply(2))).toBe(false);
      const next = siblingCursor(first), position = { ...session.position };
      votes[change === 'promote-unread' ? 2 : 193] = { score: change === 'promote-unread' ? 10 : -10 };
      // Voting changes only Access: the graph and Content read cuts stay put.
      expect(session.position).toEqual(position);
      await expect(readRealmThread(session, realm, next.reply, sort, next.cursor))
        .rejects.toBeInstanceOf(WorkReadExpired);
      const restarted = await readRealmThread(session, realm, reply(1), sort);
      const rest = siblingCursor(restarted);
      const last = await readRealmThread(session, realm, rest.reply, sort, rest.cursor);
      const reached = [...restarted.items.slice(1), ...last.items.slice(1)].map(item => item.reply);
      expect(new Set(reached).size).toBe(192);
    });
  }
}

test('a vote during hydration cannot mint a cursor with an obsolete sibling order', async () => {
  const votes: Record<number, Partial<ThreadVote>> = {};
  const { session } = world(siblings(192), { votes });
  const batch = session.deps.content!.readExactBatch.bind(session.deps.content!);
  Object.assign(session.deps.content!, { readExactBatch: async (ids: string[]) => {
    const result = await batch(ids, async ids => new Set(ids));
    votes[2] = { score: 10 };
    return result;
  } });
  await expect(readRealmThread(session, realm, reply(1), 'top')).rejects.toBeInstanceOf(WorkReadExpired);
});

test('votes leave New cursors and unrelated sibling-parent cursors valid', async () => {
  for (const sort of ['new', 'top', 'best'] as const) {
    const votes: Record<number, Partial<ThreadVote>> = {};
    const placed = [...siblings(192), { id: 500, author: 1 }, { id: 501, parent: 500, author: 1 }];
    const { session } = world(placed, { votes });
    const first = await readRealmThread(session, realm, reply(1), sort), next = siblingCursor(first);
    votes[sort === 'new' ? 2 : 501] = { score: 10 };
    const last = await readRealmThread(session, realm, reply(1), sort, next.cursor);
    expect(last.complete).toBe(true);
    expect(new Set([...first.items.slice(1), ...last.items.slice(1)].map(item => item.reply)).size).toBe(192);
  }
});

test('depth 33 and ancestors above the 32-parent window have bounded refocus reads', async () => {
  const { session } = world(branch(80));
  const first = await readRealmThread(session, realm, reply(1), 'new');
  expect(first.items).toHaveLength(33);
  expect(first.continuations).toEqual([{ kind: 'depth', reply: reply(33) }]);
  const next = await readRealmThread(session, realm, reply(33), 'new');
  expect(next.items[1]!.reply).toBe(reply(34));
  expect(next.items).toHaveLength(33);
  expect(next.ancestors).toHaveLength(32);
  expect(next.continuations).toContainEqual({ kind: 'depth', reply: reply(65) });

  const bottom = await readRealmThread(session, realm, reply(81), 'new');
  // The opener beyond this bounded window has not been disclosed. Navigation
  // starts at the oldest visible ancestor, and its control still reaches above.
  expect(bottom.thread).toBe(reply(49));
  expect(bottom.ancestors[0]!.parent).toBeNull();
  expect(bottom.ancestors).toHaveLength(32);
  expect(bottom.continuations).toEqual([{ kind: 'ancestors', reply: reply(49) }]);
  const above = await readRealmThread(session, realm, reply(49), 'new');
  expect(above.continuations).toContainEqual({ kind: 'ancestors', reply: reply(17) });
  const root = await readRealmThread(session, realm, reply(17), 'new');
  expect(root.ancestors[0]!.reply).toBe(reply(1));
  expect(root.continuations.some(item => item.kind === 'ancestors')).toBe(false);
});

test('the reply budget preserves an entry point for every deferred branch', async () => {
  const placed = siblings(191);
  placed.push(...Array.from({ length: 191 }, (_, index) =>
    ({ id: index + 1000, parent: index + 2, author: 1 })));
  const { session } = world(placed);
  const first = await readRealmThread(session, realm, reply(1), 'new');
  expect(first.items).toHaveLength(192);
  expect(first.continuations).toHaveLength(191);
  expect(first.continuations.every(item => item.kind === 'depth')).toBe(true);
  const continued = await readRealmThread(session, realm, reply(2), 'new');
  expect(continued.items.map(item => item.reply)).toEqual([reply(2), reply(1000)]);
});

test('a placed bookmark below a withdrawn ancestor keeps its own traversable branch', async () => {
  const placed = [{ id: 1, author: 1, approved: false }, { id: 2, parent: 1, author: 1 },
    ...Array.from({ length: 192 }, (_, index) => ({ id: index + 3, parent: 2, author: 1 }))];
  const { session } = world(placed);
  const readPage = session.deps.realmReplyThreads!.siblingPage.bind(session.deps.realmReplyThreads!);
  Object.assign(session.deps.realmReplyThreads!, { siblingPage: async (...args: Parameters<typeof readPage>) =>
    args[6] ? readPage(...args) : [] });
  const first = await readRealmThread(session, realm, reply(2), 'new');
  expect(first.ancestors).toEqual([]);
  expect(first.items).toHaveLength(192);
  const next = siblingCursor(first);
  const rest = await readRealmThread(session, realm, reply(2), 'new', next.cursor);
  expect(rest.items).toHaveLength(2);
  expect(new Set([...first.items.slice(1), ...rest.items.slice(1)].map(item => item.reply)).size).toBe(192);
});

test('a new reply invalidates the old walk explicitly and is reachable after restart without silent skips', async () => {
  const placed = siblings(192), { session } = world(placed);
  const first = await readRealmThread(session, realm, reply(1), 'new');
  const next = siblingCursor(first);
  placed.push({ id: 194, parent: 1, author: 1 });
  session.position.sequence = '10';
  await expect(readRealmThread(session, realm, reply(1), 'new', next.cursor))
    .rejects.toBeInstanceOf(WorkReadExpired);
  const restarted = await readRealmThread(session, realm, reply(1), 'new');
  expect(restarted.items[1]!.reply).toBe(reply(194));
  const rest = siblingCursor(restarted);
  const second = await readRealmThread(session, realm, rest.reply, 'new', rest.cursor);
  const reached = [...restarted.items.slice(1), ...second.items.slice(1)].map(item => item.reply);
  expect(new Set(reached).size).toBe(193);
});

test('sibling continuations retain their published scope across unrelated graph writes', async () => {
  for (const sort of ['best', 'top', 'new'] as const) {
    const { session } = world(siblings(192));
    const first = await readRealmThread(session, realm, reply(1), sort);
    const next = siblingCursor(first);
    session.position.sequence = '1000';
    const last = await readRealmThread(session, realm, reply(1), sort, next.cursor);
    expect(last.complete).toBe(true);
    expect(new Set([...first.items.slice(1), ...last.items.slice(1)].map(item => item.reply)).size).toBe(192);
  }
});

test('unrelated graph movement during hydration does not mint an expired sibling continuation', async () => {
  const { session } = world(siblings(192));
  session.options.localBasis = true;
  Object.assign(session, { fencesSelectedUnits: true });
  const batch = session.deps.content!.readExactBatch.bind(session.deps.content!);
  Object.assign(session.deps.content!, { readExactBatch: async (ids: string[]) => {
    const result = await batch(ids, async ids => new Set(ids));
    session.position.sequence = String(Number(session.position.sequence) + 1);
    return result;
  } });
  const first = await readRealmThread(session, realm, reply(1), 'new');
  const next = siblingCursor(first);
  const last = await readRealmThread(session, realm, reply(1), 'new', next.cursor);
  expect(last.complete).toBe(true);
  expect(new Set([...first.items.slice(1), ...last.items.slice(1)].map(item => item.reply)).size).toBe(192);
});

test('local thread target summaries fence their selected root rather than unrelated graph movement', async () => {
  const { session } = world(siblings(2));
  const owner = new WorkReadSession(session.deps, session.request, { localBasis: true }, session.position);
  await targetSummaries(owner, [work]);
  session.position.sequence = '1000';
  await expect(owner.fenceDependencies()).resolves.toBeUndefined();
  const query = session.deps.environment.fuseki.query.bind(session.deps.environment.fuseki);
  session.deps.environment.fuseki.query = async (...args) => {
    const result = await query(...args);
    for (const row of result.results?.bindings ?? []) if (row.r?.value === work && row.label) {
      row.label = { ...row.label, value: 'A changed selected root title' };
    }
    return result;
  };
  await expect(owner.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
});

/** Exercise the production session's dependency ledger while the bounded
 * graph and owner adapters retain the same deterministic thread fixture. */
function selectedThreadSession(fixture: ReturnType<typeof world>) {
  const { session } = fixture;
  const owner = new WorkReadSession(session.deps, session.request, { ...session.options, localBasis: true },
    { ...session.position });
  Object.assign(session, { options: owner.options, fencesSelectedUnits: owner.fencesSelectedUnits,
    observeDependency: owner.observeDependency.bind(owner) });
  return { session, owner };
}

test('selected thread owner closure stays usable under unrelated graph movement', async () => {
  const { session, owner } = selectedThreadSession(world(siblings(2)));
  const page = await readRealmThread(session, realm, reply(1), 'new');
  session.position.sequence = '1000';
  await expect(owner.fenceDependencies()).resolves.toBeUndefined();
  expect(page.items.map(item => item.reply)).toEqual([reply(1), reply(3), reply(2)]);
  expect(owner.position.sequence).toBe('9');
});

test('selected pinned body erasure refuses delivery at the owner closure', async () => {
  const placed = siblings(2).map(item => ({ ...item, bodyUnavailable: false }));
  const { session, owner } = selectedThreadSession(world(placed));
  const page = await readRealmThread(session, realm, reply(1), 'new');
  expect(page.items.find(item => item.reply === reply(2))?.body).toBeTruthy();
  placed[1]!.bodyUnavailable = true;
  await expect(owner.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
});

test('selected Content approval removal refuses delivery at the owner closure', async () => {
  const placed = siblings(2).map(item => ({ ...item, approved: true }));
  const { session, owner } = selectedThreadSession(world(placed));
  await readRealmThread(session, realm, reply(1), 'new');
  placed[1]!.approved = false;
  await expect(owner.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
});

test('New display votes close independently of the sibling ordering revision', async () => {
  const votes: Record<number, Partial<ThreadVote>> = {};
  const { session, owner } = selectedThreadSession(world(siblings(2), { votes }));
  await readRealmThread(session, realm, reply(1), 'new');
  votes[2] = { value: 1, revision: 'changed-reader-vote' };
  await expect(owner.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
});

test('a displayed thread count closes its selected child admission result', async () => {
  const placed = siblings(2).map(item => ({ ...item, approved: true }));
  const { session, owner } = selectedThreadSession(world(placed));
  const page = await readRealmThreads(session, realm, { sort: 'new' });
  expect(page.items[0]!.replies).toEqual({ value: 2, kind: 'exact' });
  placed[1]!.approved = false;
  await expect(owner.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
});

test('an empty selected sibling relation is fenced before it can become a false empty branch', async () => {
  const placed = siblings(0);
  const { session, owner } = selectedThreadSession(world(placed));
  const page = await readRealmThread(session, realm, reply(1), 'new');
  expect(page.items.map(item => item.reply)).toEqual([reply(1)]);
  expect(page.complete).toBe(true);
  placed.push({ id: 2, parent: 1, author: 1 });
  await expect(owner.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
});

test('thread projection fences receive the same Realm and focused branch before and after hydration', async () => {
  const { session } = world(siblings(2));
  const scopes: unknown[][] = [];
  Object.assign(session.deps.realmReplyThreads!, { assertThreadProjection: async (...args: unknown[]) => {
    scopes.push(args.slice(1));
  } });
  await readRealmThread(session, realm, reply(1), 'new');
  expect(scopes).toEqual([[realm, reply(1), undefined],
    [realm, reply(1), undefined, [reply(1), reply(3), reply(2)]]]);
});

test('a removed cursor anchor leaves no gap in a keyset seek', async () => {
  const placed = siblings(192), { session } = world(placed);
  const first = await readRealmThread(session, realm, reply(1), 'new');
  const next = siblingCursor(first), anchor = first.items.at(-1)!.reply;
  placed.splice(placed.findIndex(item => reply(item.id) === anchor), 1);
  // The owner key survives removal before the graph position catches up; once
  // that position moves, the same cursor gets the explicit restart above.
  const second = await readRealmThread(session, realm, reply(1), 'new', next.cursor);
  expect(second.items.map(item => item.reply)).toEqual([reply(1), reply(2)]);
});

test('large valid reply bodies continue within the unchanged response-byte budget', async () => {
  const placed = siblings(192).map(item => ({ ...item, body: '界'.repeat(REALM_THREAD_COST.bodyChars) }));
  const { session } = world(placed);
  const reached: string[] = [];
  let cursor: string | undefined;
  for (let turn = 0; turn < 10; turn++) {
    const page = await readRealmThread(session, realm, reply(1), 'new', cursor);
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(REALM_THREAD_COST.responseBytes);
    expect(page.items.length).toBeGreaterThan(1);
    reached.push(...page.items.slice(1).map(item => item.reply));
    if (page.complete) break;
    cursor = siblingCursor(page).cursor;
  }
  expect(reached).toHaveLength(192);
  expect(new Set(reached).size).toBe(192);
});

test('large document context keeps downward and upward progress within the response-byte budget', async () => {
  const { session } = world(branch(80));
  const snapshot = fromMarkdown(Array.from({ length: 40 }, () =>
    `[reference](https://example.test/${'a'.repeat(5000)})`).join(' '), 'text');
  const authored = authoredDocumentBody({ document: snapshot });
  const batch = session.deps.content!.readExactBatch.bind(session.deps.content!);
  Object.assign(session.deps.content!, { readExactBatch: async (ids: string[]) =>
    (await batch(ids, async ids => new Set(ids))).map(result => result.status === 'available'
      ? { ...result, body: { ...result.body, ...authored } } : result) });
  const middle = await readRealmThread(session, realm, reply(49), 'new');
  expect(Buffer.byteLength(JSON.stringify(middle), 'utf8')).toBeLessThanOrEqual(REALM_THREAD_COST.responseBytes);
  expect(middle.items.length).toBeGreaterThan(1);
  expect(middle.ancestors.length).toBeLessThan(REALM_THREAD_COST.ancestors);
  const down = middle.continuations.find(item => item.kind === 'depth');
  const up = middle.continuations.find(item => item.kind === 'ancestors');
  expect(down?.reply).toBe(middle.items.at(-1)!.reply);
  expect(up?.reply).toBe(middle.ancestors[0]!.reply);
  const next = await readRealmThread(session, realm, down!.reply, 'new');
  expect(next.items[1]!.reply).toBe(reply(Number.parseInt(down!.reply.slice(-12), 16) + 1));
  const previous = await readRealmThread(session, realm, up!.reply, 'new');
  expect(Number.parseInt(previous.ancestors[0]!.reply.slice(-12), 16))
    .toBeLessThan(Number.parseInt(up!.reply.slice(-12), 16));
});

test('continuations bind the parent, Realm, sort, language and reader; recovery epochs cannot reuse them', async () => {
  const { session } = world(siblings(192));
  const next = siblingCursor(await readRealmThread(session, realm, reply(1), 'new'));
  for (const [focus, sort, selectedRealm] of [
    [reply(2), 'new', realm], [reply(1), 'top', realm], [reply(1), 'new', reply(999)],
  ] as const) {
    await expect(readRealmThread(session, selectedRealm, focus, sort, next.cursor))
      .rejects.toBeInstanceOf(WorkReadInvalid);
  }
  Object.assign(session, { displayLanguages: ['ja'] });
  await expect(readRealmThread(session, realm, reply(1), 'new', next.cursor))
    .rejects.toBeInstanceOf(WorkReadInvalid);
  Object.assign(session, { displayLanguages: ['en'] });
  session.position.dataEpoch = 'restored';
  await expect(readRealmThread(session, realm, reply(1), 'new', next.cursor))
    .rejects.toBeInstanceOf(WorkReadExpired);
});

test('continuations never admit a withdrawn focus, an inaccessible Realm or an incomplete projection', async () => {
  const placed = siblings(192), { session } = world(placed);
  const next = siblingCursor(await readRealmThread(session, realm, reply(1), 'new'));
  Object.assign(placed[0]!, { approved: false });
  await expect(readRealmThread(session, realm, reply(1), 'new', next.cursor))
    .rejects.toBeInstanceOf(WorkReadMissing);
  const denied = world(siblings(192), { privateRealm: true });
  await expect(readRealmThread(denied.session, realm, reply(1), 'new', next.cursor))
    .rejects.toBeInstanceOf(WorkReadMissing);
  expect(denied.calls.store).toBe(0);
  Object.assign(session.deps.realmReplyThreads!, { assertThreadProjection: async () => {
    throw new WorkReadUnavailable('Realm replies are projecting');
  } });
  await expect(readRealmThread(session, realm, reply(1), 'new', next.cursor))
    .rejects.toBeInstanceOf(WorkReadUnavailable);
});


test('wide and deep continuations fence only each selected neighbourhood and reach every branch', async () => {
  const placed = [...siblings(193), ...Array.from({ length: 80 }, (_, index) =>
    ({ id: 1000 + index, parent: index ? 999 + index : 1, author: 1 }))];
  for (const sort of ['best', 'top', 'new'] as const) {
    const { session } = world(placed);
    const scopes: string[][] = [];
    Object.assign(session.deps.realmReplyThreads!, { assertThreadProjection: async (_session: WorkReadSession,
      _realm: string, focus: string, _population?: string, selected: readonly string[] = [focus]) => {
      scopes.push([...selected]);
    } });
    const pending: { reply: string; cursor?: string }[] = [{ reply: reply(1) }];
    const seen = new Set<string>(), controls = new Set<string>();
    while (pending.length) {
      const next = pending.shift()!;
      const page = await readRealmThread(session, realm, next.reply, sort, next.cursor);
      page.items.forEach(item => seen.add(item.reply));
      for (const continuation of page.continuations.filter(item => item.kind !== 'ancestors')) {
        const key = JSON.stringify(continuation);
        expect(controls.has(key)).toBe(false);
        controls.add(key);
        pending.push(continuation);
      }
      expect(controls.size).toBeLessThan(20);
    }
    expect([...seen].sort()).toEqual(placed.map(item => reply(item.id)).sort());
    expect(scopes.filter((_scope, index) => index % 2 === 0).every(scope => scope.length === 1)).toBe(true);
    expect(Math.max(...scopes.map(scope => scope.length)))
      .toBeLessThanOrEqual(REALM_THREAD_COST.replies + 1 + REALM_THREAD_COST.ancestors);
    expect(scopes.every(scope => scope.length < placed.length)).toBe(true);
  }
});
